import { once } from "node:events";

import type { FastifyReply, FastifyRequest } from "fastify";

import { ApiErrorSchema, type InstallationEvent } from "@kestrel/contracts";
import {
  readEventReplayBatch,
  readOperatorSessionState,
  validateCursor,
  type DatabasePool,
  type EventCursorValidation,
} from "@kestrel/database";

const EVENT_BATCH_SIZE = 100;
const HEARTBEAT_INTERVAL_MS = 15_000;
const POLL_INTERVAL_MS = 1_000;

export function encodeSseEvent(event: InstallationEvent): string {
  return `id: ${event.eventId}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function millisecondsUntilSessionExpiry(expiresAt: string, now = new Date()): number {
  const expiry = Date.parse(expiresAt);
  return Number.isFinite(expiry) ? Math.max(0, expiry - now.getTime()) : 0;
}

function encodeResetRequired(correlationId: string, firstAvailableEventId: string): string {
  const error = ApiErrorSchema.parse({
    schemaVersion: 1,
    code: "EVENT_CURSOR_EXPIRED",
    message: "The event cursor is outside retained history",
    correlationId,
    firstAvailableEventId,
    refetch: "/api/v1/installation",
  });
  return `event: reset-required\ndata: ${JSON.stringify(error)}\n\n`;
}

export type EventStreamStartResult =
  { streaming: true } | ({ streaming: false } & Extract<EventCursorValidation, { valid: false }>);

export interface StartEventStreamOptions {
  cursor: string;
  pool: DatabasePool;
  reply: FastifyReply;
  request: FastifyRequest;
  shutdownSignal: AbortSignal;
}

export async function startInstallationEventStream({
  cursor: initialCursor,
  pool,
  reply,
  request,
  shutdownSignal,
}: StartEventStreamOptions): Promise<EventStreamStartResult | null> {
  const session = request.operatorSession;
  const sessionGeneration = request.operatorSessionGeneration;
  if (session === null || sessionGeneration === null) {
    throw new Error("An authenticated Operator session is required for event streaming");
  }
  const authenticatedSession = session;
  const authenticatedSessionGeneration = sessionGeneration;
  let cursor = initialCursor;
  let closed = false;
  let releaseClient: ((error?: Error) => void) | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let sessionExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  const streamAbort = new AbortController();

  function isClosed(): boolean {
    return closed;
  }

  const onRequestClose = () => cleanup(false);
  const onShutdown = () => {
    cleanup(false);
    reply.hijack();
    reply.raw.destroy();
  };
  const onDatabaseError = (error: Error) => {
    request.log.error({ err: error, event: "events.listener_failed" });
    cleanup(true, error);
  };

  function cleanup(endResponse: boolean, databaseError?: Error): void {
    if (closed) return;
    closed = true;
    streamAbort.abort();
    clearInterval(heartbeatTimer);
    clearInterval(pollTimer);
    clearTimeout(sessionExpiryTimer);
    reply.raw.removeListener("close", onRequestClose);
    shutdownSignal.removeEventListener("abort", onShutdown);
    if (endResponse && !reply.raw.destroyed) {
      reply.hijack();
      reply.raw.end();
    }
    releaseClient?.(databaseError);
  }

  reply.raw.once("close", onRequestClose);
  shutdownSignal.addEventListener("abort", onShutdown, { once: true });
  if (shutdownSignal.aborted || reply.raw.destroyed) {
    onShutdown();
    return null;
  }

  try {
    const client = await pool.connect();
    const onNotification = (notification: { channel: string }) => {
      if (notification.channel === "kestrel_events") scheduleDrain();
    };
    releaseClient = (error) => {
      client.removeListener("error", onDatabaseError);
      client.removeListener("notification", onNotification);
      // This connection is dedicated to LISTEN. Destroy it so pending queries or
      // an unavailable database cannot hold stream shutdown behind UNLISTEN.
      client.release(error ?? true);
    };
    if (isClosed()) {
      releaseClient();
      return null;
    }
    client.on("error", onDatabaseError);
    await client.query("LISTEN kestrel_events");
    if (isClosed()) return null;
    const validation = await validateCursor(client, initialCursor);
    if (isClosed()) return null;
    if (!validation.valid) {
      cleanup(false);
      return { ...validation, streaming: false };
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    reply.raw.flushHeaders();

    async function writeChunk(chunk: string): Promise<void> {
      if (closed || reply.raw.writableEnded) return;
      if (!reply.raw.write(chunk)) {
        try {
          await once(reply.raw, "drain", { signal: streamAbort.signal });
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") return;
          throw error;
        }
      }
    }

    async function drain(): Promise<void> {
      while (!closed) {
        const currentOperator = await readOperatorSessionState(
          client,
          authenticatedSession.operator.id,
        );
        if (isClosed()) return;
        if (
          currentOperator === null ||
          currentOperator.username !== authenticatedSession.operator.username ||
          currentOperator.credentialVersion !== authenticatedSession.credentialVersion ||
          currentOperator.sessionGeneration !== authenticatedSessionGeneration
        ) {
          request.log.info({
            event: "events.session_invalidated",
            operatorId: authenticatedSession.operator.id,
          });
          cleanup(true);
          return;
        }
        const batch = await readEventReplayBatch(client, cursor, EVENT_BATCH_SIZE);
        if (isClosed()) return;
        if (!batch.valid) {
          await writeChunk(encodeResetRequired(request.id, batch.firstAvailable));
          cleanup(true);
          return;
        }

        for (const event of batch.events) {
          await writeChunk(encodeSseEvent(event));
          cursor = event.eventId;
        }
        if (batch.events.length < EVENT_BATCH_SIZE) return;
      }
    }

    let streamWork = Promise.resolve();
    function enqueue(work: () => Promise<void>): void {
      if (closed) return;
      streamWork = streamWork.then(work).catch((error: unknown) => {
        if (!closed) {
          request.log.error({ err: error, event: "events.stream_failed" });
          cleanup(true, error instanceof Error ? error : undefined);
        }
      });
    }
    function scheduleDrain(): void {
      enqueue(drain);
    }

    pollTimer = setInterval(scheduleDrain, POLL_INTERVAL_MS);
    heartbeatTimer = setInterval(() => {
      enqueue(async () => writeChunk(": keep-alive\n\n"));
    }, HEARTBEAT_INTERVAL_MS);
    sessionExpiryTimer = setTimeout(() => {
      request.log.info({
        event: "events.session_expired",
        operatorId: authenticatedSession.operator.id,
      });
      cleanup(true);
    }, millisecondsUntilSessionExpiry(authenticatedSession.expiresAt));
    client.on("notification", onNotification);
    enqueue(async () => {
      await writeChunk(": connected\n\n");
      await drain();
    });

    return { streaming: true };
  } catch (error) {
    if (isClosed()) return null;
    cleanup(reply.sent, error instanceof Error ? error : undefined);
    throw error;
  }
}
