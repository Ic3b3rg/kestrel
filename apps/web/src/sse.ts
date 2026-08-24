import { once } from "node:events";

import type { FastifyReply, FastifyRequest } from "fastify";

import { ApiErrorSchema, type InstallationEvent } from "@kestrel/contracts";
import {
  readEventsAfter,
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
}

export async function startInstallationEventStream({
  cursor: initialCursor,
  pool,
  reply,
  request,
}: StartEventStreamOptions): Promise<EventStreamStartResult> {
  const client = await pool.connect();
  let transferred = false;

  try {
    await client.query("LISTEN kestrel_events");
    const validation = await validateCursor(client, initialCursor);
    if (!validation.valid) {
      await client.query("UNLISTEN kestrel_events");
      client.release();
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

    let cursor = initialCursor;
    let closed = false;
    let cleanupPromise: Promise<void> | undefined;
    const streamAbort = new AbortController();

    const onRequestClose = () => {
      void cleanup(false);
    };
    const onDatabaseError = (error: Error) => {
      request.log.error({ err: error, event: "events.listener_failed" });
      void cleanup(true, error);
    };
    const onNotification = (notification: { channel: string }) => {
      if (notification.channel === "kestrel_events") {
        scheduleDrain();
      }
    };

    async function cleanup(endResponse: boolean, databaseError?: Error): Promise<void> {
      cleanupPromise ??= (async () => {
        closed = true;
        streamAbort.abort();
        clearInterval(heartbeatTimer);
        clearInterval(pollTimer);
        request.raw.removeListener("close", onRequestClose);
        client.removeListener("error", onDatabaseError);
        client.removeListener("notification", onNotification);
        if (endResponse && !reply.raw.writableEnded) {
          reply.raw.end();
        }
        await client.query("UNLISTEN kestrel_events").catch(() => undefined);
        client.release(databaseError);
      })();
      return cleanupPromise;
    }

    async function writeChunk(chunk: string): Promise<void> {
      if (closed || reply.raw.writableEnded) {
        return;
      }
      if (!reply.raw.write(chunk)) {
        try {
          await once(reply.raw, "drain", { signal: streamAbort.signal });
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            return;
          }
          throw error;
        }
      }
    }

    async function drain(): Promise<void> {
      while (!closed) {
        const currentValidation = await validateCursor(client, cursor);
        if (!currentValidation.valid) {
          await writeChunk(encodeResetRequired(request.id, currentValidation.firstAvailable));
          await cleanup(true);
          return;
        }

        const events = await readEventsAfter(client, cursor, EVENT_BATCH_SIZE);
        for (const event of events) {
          await writeChunk(encodeSseEvent(event));
          cursor = event.eventId;
        }
        if (events.length < EVENT_BATCH_SIZE) {
          return;
        }
      }
    }

    let streamWork = Promise.resolve();
    function enqueue(work: () => Promise<void>): void {
      streamWork = streamWork.then(work).catch(async (error: unknown) => {
        if (!closed) {
          request.log.error({ err: error, event: "events.stream_failed" });
          await cleanup(true, error instanceof Error ? error : undefined);
        }
      });
    }
    function scheduleDrain(): void {
      enqueue(drain);
    }

    const pollTimer = setInterval(scheduleDrain, POLL_INTERVAL_MS);
    const heartbeatTimer = setInterval(() => {
      enqueue(async () => writeChunk(": keep-alive\n\n"));
    }, HEARTBEAT_INTERVAL_MS);
    request.raw.once("close", onRequestClose);
    client.on("error", onDatabaseError);
    client.on("notification", onNotification);
    enqueue(async () => {
      await writeChunk(": connected\n\n");
      await drain();
    });

    transferred = true;
    return { streaming: true };
  } catch (error) {
    if (!transferred) {
      if (reply.sent && !reply.raw.writableEnded) {
        reply.raw.end();
      }
      await client.query("UNLISTEN kestrel_events").catch(() => undefined);
      client.release(error instanceof Error ? error : undefined);
    }
    throw error;
  }
}
