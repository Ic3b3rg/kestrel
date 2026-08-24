import { createParser } from "eventsource-parser";

import {
  ApiErrorSchema,
  DiagnosticAcceptedSchema,
  EventCursorSchema,
  InstallationEventSchema,
  InstallationSnapshotSchema,
  LoginCommandSchema,
  SessionSchema,
  type ApiError,
  type DiagnosticAccepted,
  type EventCursor,
  type InstallationEvent,
  type InstallationSnapshot,
  type LoginCommand,
  type Session,
} from "@kestrel/contracts";

const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;
const STABLE_STREAM_MS = 10_000;

interface Parser<T> {
  parse(value: unknown): T;
}

export type EventConnectionState = "connected" | "connecting" | "cursor-expired" | "reconnecting";

export interface StreamInstallationEventsOptions {
  after: EventCursor;
  onConnectionState?(state: EventConnectionState): void;
  onCursorExpired(
    error: Extract<ApiError, { code: "EVENT_CURSOR_EXPIRED" }>,
  ): EventCursor | Promise<EventCursor>;
  onEvent(event: InstallationEvent): void;
  signal: AbortSignal;
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly details: ApiError,
  ) {
    super(details.message);
    this.name = "ApiClientError";
  }
}

export class InvalidServerResponseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidServerResponseError";
  }
}

function parseServerValue<T>(parser: Parser<T>, value: unknown, description: string): T {
  try {
    return parser.parse(value);
  } catch (error) {
    throw new InvalidServerResponseError(`The server returned an invalid ${description}`, {
      cause: error,
    });
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new InvalidServerResponseError("The server returned invalid JSON", { cause: error });
  }
}

async function requireJson<T>(
  response: Response,
  parser: Parser<T>,
  description: string,
): Promise<T> {
  const body = await readJson(response);
  if (!response.ok) {
    throw new ApiClientError(response.status, parseServerValue(ApiErrorSchema, body, "API error"));
  }
  return parseServerValue(parser, body, description);
}

export async function fetchInstallation(signal?: AbortSignal): Promise<InstallationSnapshot> {
  const response = await fetch("/api/v1/installation", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    method: "GET",
    signal: signal ?? null,
  });
  return requireJson(response, InstallationSnapshotSchema, "Installation snapshot");
}

export async function fetchSession(signal?: AbortSignal): Promise<Session> {
  const response = await fetch("/api/v1/session", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    method: "GET",
    signal: signal ?? null,
  });
  return requireJson(response, SessionSchema, "Operator session");
}

export async function loginOperator(command: LoginCommand, signal?: AbortSignal): Promise<Session> {
  const validated = LoginCommandSchema.parse(command);
  const response = await fetch("/api/v1/session", {
    body: JSON.stringify(validated),
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: signal ?? null,
  });
  return requireJson(response, SessionSchema, "Operator session");
}

export async function runDiagnostic(signal?: AbortSignal): Promise<DiagnosticAccepted> {
  const response = await fetch("/api/v1/installation/diagnostics", {
    body: "{}",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: signal ?? null,
  });
  return requireJson(response, DiagnosticAcceptedSchema, "diagnostic response");
}

function parseEventData(value: string, description: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new InvalidServerResponseError(`The server returned invalid ${description} JSON`, {
      cause: error,
    });
  }
}

function parseCursorExpired(value: unknown) {
  const error = parseServerValue(ApiErrorSchema, value, "cursor-expiry error");
  if (error.code !== "EVENT_CURSOR_EXPIRED") {
    throw new InvalidServerResponseError("The server returned the wrong cursor-expiry error");
  }
  return error;
}

type StreamReadResult =
  | { kind: "aborted" }
  | { error: Extract<ApiError, { code: "EVENT_CURSOR_EXPIRED" }>; kind: "cursor-expired" }
  | { kind: "ended" };

async function readEventStream(
  response: Response,
  cursor: EventCursor,
  options: StreamInstallationEventsOptions,
): Promise<{ cursor: EventCursor; result: StreamReadResult }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("text/event-stream")) {
    throw new InvalidServerResponseError("The server did not return an event stream");
  }
  if (response.body === null) {
    throw new InvalidServerResponseError("The event stream has no response body");
  }

  let confirmedCursor = cursor;
  let cursorExpired: Extract<ApiError, { code: "EVENT_CURSOR_EXPIRED" }> | undefined;
  const parser = createParser({
    maxBufferSize: 64 * 1_024,
    onEvent(message) {
      const body = parseEventData(message.data, "event");
      if (message.event === "reset-required") {
        cursorExpired = parseCursorExpired(body);
        return;
      }

      const event = parseServerValue(InstallationEventSchema, body, "Installation event");
      if (message.id !== event.eventId || message.event !== event.eventType) {
        throw new InvalidServerResponseError("The SSE fields do not match the event envelope");
      }
      if (BigInt(event.eventId) <= BigInt(confirmedCursor)) {
        throw new InvalidServerResponseError("The event stream did not advance its cursor");
      }
      confirmedCursor = event.eventId;
      options.onEvent(event);
    },
  });
  const decoder = new TextDecoder();
  const reader = response.body.getReader();

  try {
    while (!options.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        return { cursor: confirmedCursor, result: { kind: "ended" } };
      }
      parser.feed(decoder.decode(chunk.value, { stream: true }));
      if (cursorExpired) {
        return {
          cursor: confirmedCursor,
          result: { error: cursorExpired, kind: "cursor-expired" },
        };
      }
    }
    return { cursor: confirmedCursor, result: { kind: "aborted" } };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function waitForReconnect(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function isFatalStreamError(error: unknown): boolean {
  return (
    error instanceof InvalidServerResponseError ||
    (error instanceof ApiClientError && error.status < 500)
  );
}

function isSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export async function streamInstallationEvents(
  options: StreamInstallationEventsOptions,
): Promise<void> {
  let cursor = parseServerValue(EventCursorSchema, options.after, "event cursor");
  let reconnectAttempt = 0;
  options.onConnectionState?.("connecting");

  while (!options.signal.aborted) {
    try {
      const response = await fetch("/api/v1/events", {
        credentials: "same-origin",
        headers: {
          Accept: "text/event-stream",
          "Last-Event-ID": cursor,
        },
        method: "GET",
        signal: options.signal,
      });

      if (response.status === 409) {
        const error = parseCursorExpired(await readJson(response));
        options.onConnectionState?.("cursor-expired");
        cursor = parseServerValue(
          EventCursorSchema,
          await options.onCursorExpired(error),
          "event cursor",
        );
        reconnectAttempt = 0;
        options.onConnectionState?.("connecting");
        continue;
      }
      if (!response.ok) {
        await requireJson(response, InstallationEventSchema, "Installation event");
      }

      options.onConnectionState?.("connected");
      const connectedAt = Date.now();
      const cursorAtConnection = cursor;
      const stream = await readEventStream(response, cursor, options);
      cursor = stream.cursor;
      if (stream.result.kind === "aborted" || isSignalAborted(options.signal)) {
        return;
      }
      if (stream.result.kind === "cursor-expired") {
        reconnectAttempt = 0;
        options.onConnectionState?.("cursor-expired");
        cursor = parseServerValue(
          EventCursorSchema,
          await options.onCursorExpired(stream.result.error),
          "event cursor",
        );
        options.onConnectionState?.("connecting");
        continue;
      }
      if (cursor !== cursorAtConnection || Date.now() - connectedAt >= STABLE_STREAM_MS) {
        reconnectAttempt = 0;
      }
      throw new Error("The event stream disconnected");
    } catch (error) {
      if (isSignalAborted(options.signal)) {
        return;
      }
      if (isFatalStreamError(error)) {
        throw error;
      }

      options.onConnectionState?.("reconnecting");
      const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
      await waitForReconnect(delay ?? RECONNECT_DELAYS_MS.at(-1) ?? 5_000, options.signal);
      reconnectAttempt += 1;
    }
  }
}
