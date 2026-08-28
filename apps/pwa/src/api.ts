import { createParser } from "eventsource-parser";

import {
  ApiErrorSchema,
  ChangeIntentVersionCreatedSchema,
  CreateChangeIntentVersionCommandSchema,
  CredentialChangeCommandSchema,
  DiagnosticAcceptedSchema,
  EventCursorSchema,
  InstallationEventSchema,
  InstallationSnapshotSchema,
  HostGitHubProjectInboxSchema,
  ObserveHostGitHubPullRequestCommandSchema,
  LoginCommandSchema,
  OpenPublicGitHubPullRequestCommandSchema,
  LocalRepositoryInventorySchema,
  LocalRepositoryReferencesSchema,
  ProjectInboxSchema,
  ProjectUpsertedSchema,
  RetainReviewRevisionCommandSchema,
  ReviewRevisionAvailableSchema,
  serializeCredentialChangeCommand,
  SessionSchema,
  StepUpCommandSchema,
  StepUpProofSchema,
  type ApiError,
  type ChangeIntentVersionCreated,
  type CreateChangeIntentVersionCommand,
  type DiagnosticAccepted,
  type EventCursor,
  type InstallationEvent,
  type InstallationSnapshot,
  type HostGitHubProjectInbox,
  type ObserveHostGitHubPullRequestCommand,
  type LoginCommand,
  type OpenPublicGitHubPullRequestCommand,
  type LocalRepositoryInventory,
  type LocalRepositoryReferences,
  type ProjectInbox,
  type ProjectUpserted,
  type RetainReviewRevisionCommand,
  type ReviewRevisionAvailable,
  type Session,
} from "@kestrel/contracts";

const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;
const STABLE_STREAM_MS = 10_000;
const CSRF_COOKIE_NAME = "__Host-kestrel-csrf";

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

function readCsrfToken(): string {
  const cookieHeader = typeof document === "undefined" ? "" : document.cookie;
  const prefix = `${CSRF_COOKIE_NAME}=`;
  const matches = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix));
  const token = matches.length === 1 ? matches[0]?.slice(prefix.length) : undefined;
  if (!token || !/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new Error("The authenticated mutation CSRF cookie is unavailable");
  }
  return token;
}

function authenticatedMutationHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Kestrel-CSRF": readCsrfToken(),
    ...extra,
  };
}

async function requireNoContent(response: Response, description: string): Promise<void> {
  if (!response.ok) {
    const body = await readJson(response);
    throw new ApiClientError(response.status, parseServerValue(ApiErrorSchema, body, "API error"));
  }
  if (response.status !== 204 || (await response.arrayBuffer()).byteLength !== 0) {
    throw new InvalidServerResponseError(`The server returned an invalid ${description}`);
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

export async function fetchProjectInbox(signal?: AbortSignal): Promise<ProjectInbox> {
  const response = await fetch("/api/v1/projects", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    method: "GET",
    signal: signal ?? null,
  });
  return requireJson(response, ProjectInboxSchema, "Project inbox");
}

export async function createChangeIntentVersion(
  projectId: string,
  changeProposalId: string,
  command: CreateChangeIntentVersionCommand,
  signal?: AbortSignal,
): Promise<ChangeIntentVersionCreated> {
  const idSchema = ProjectInboxSchema.shape.projects.element.shape.id;
  const validatedProjectId = idSchema.parse(projectId);
  const validatedProposalId = idSchema.parse(changeProposalId);
  const validatedCommand = CreateChangeIntentVersionCommandSchema.parse(command);
  const response = await fetch(
    `/api/v1/projects/${encodeURIComponent(validatedProjectId)}/change-proposals/${encodeURIComponent(validatedProposalId)}/change-intents`,
    {
      body: JSON.stringify(validatedCommand),
      credentials: "same-origin",
      headers: authenticatedMutationHeaders(),
      method: "POST",
      signal: signal ?? null,
    },
  );
  return requireJson(response, ChangeIntentVersionCreatedSchema, "Change Intent version response");
}

export async function fetchHostGitHubProjectInbox(
  projectId: string,
  refresh = false,
  signal?: AbortSignal,
): Promise<HostGitHubProjectInbox> {
  const validatedId = ProjectInboxSchema.shape.projects.element.shape.id.parse(projectId);
  const response = await fetch(
    `/api/v1/projects/${encodeURIComponent(validatedId)}/provider/github${refresh ? "?refresh=true" : ""}`,
    {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      method: "GET",
      signal: signal ?? null,
    },
  );
  return requireJson(response, HostGitHubProjectInboxSchema, "host GitHub Project inbox");
}

export async function observeHostGitHubPullRequest(
  projectId: string,
  command: ObserveHostGitHubPullRequestCommand,
  signal?: AbortSignal,
): Promise<ProjectUpserted> {
  const validatedId = ProjectInboxSchema.shape.projects.element.shape.id.parse(projectId);
  const validated = ObserveHostGitHubPullRequestCommandSchema.parse(command);
  const response = await fetch(
    `/api/v1/projects/${encodeURIComponent(validatedId)}/provider/github/pull-requests/observe`,
    {
      body: JSON.stringify(validated),
      credentials: "same-origin",
      headers: authenticatedMutationHeaders(),
      method: "POST",
      signal: signal ?? null,
    },
  );
  return requireJson(response, ProjectUpsertedSchema, "observed Project response");
}

export async function fetchLocalRepositories(
  signal?: AbortSignal,
): Promise<LocalRepositoryInventory> {
  const response = await fetch("/api/v1/local-repository-sources", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    method: "GET",
    signal: signal ?? null,
  });
  return requireJson(response, LocalRepositoryInventorySchema, "local repository inventory");
}

export async function fetchLocalRepositoryReferences(
  repositoryId: string,
  signal?: AbortSignal,
): Promise<LocalRepositoryReferences> {
  const validatedId =
    LocalRepositoryInventorySchema.shape.repositories.element.shape.repositoryId.parse(
      repositoryId,
    );
  const response = await fetch(
    `/api/v1/local-repository-sources/${encodeURIComponent(validatedId)}/references`,
    {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      method: "GET",
      signal: signal ?? null,
    },
  );
  return requireJson(response, LocalRepositoryReferencesSchema, "local repository references");
}

export async function retainReviewRevision(
  command: RetainReviewRevisionCommand,
  signal?: AbortSignal,
): Promise<ReviewRevisionAvailable> {
  const validated = RetainReviewRevisionCommandSchema.parse(command);
  const response = await fetch("/api/v1/review-revisions", {
    body: JSON.stringify(validated),
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    method: "POST",
    signal: signal ?? null,
  });
  return requireJson(response, ReviewRevisionAvailableSchema, "Review Revision response");
}

export async function openPublicGitHubPullRequest(
  command: OpenPublicGitHubPullRequestCommand,
  signal?: AbortSignal,
): Promise<ProjectUpserted> {
  const validated = OpenPublicGitHubPullRequestCommandSchema.parse(command);
  const response = await fetch("/api/v1/projects", {
    body: JSON.stringify(validated),
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    method: "POST",
    signal: signal ?? null,
  });
  return requireJson(response, ProjectUpsertedSchema, "Project response");
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
  const response = await fetch("/auth/login", {
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

export interface LogoutOutcome {
  auditError: ApiError | null;
}

export async function logoutOperator(signal?: AbortSignal): Promise<LogoutOutcome> {
  const response = await fetch("/auth/logout", {
    body: "{}",
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    method: "POST",
    signal: signal ?? null,
  });
  if (response.status === 503) {
    return {
      auditError: parseServerValue(ApiErrorSchema, await readJson(response), "API error"),
    };
  }
  await requireNoContent(response, "logout response");
  return { auditError: null };
}

export interface UpdateOperatorCredentialsInput {
  currentPassword: string;
  newPassword: string;
  session: Session;
  username: string;
}

export async function updateOperatorCredentials(
  input: UpdateOperatorCredentialsInput,
  signal?: AbortSignal,
): Promise<void> {
  const command = CredentialChangeCommandSchema.parse({
    expectedVersion: input.session.credentialVersion,
    newPassword: input.newPassword,
    username: input.username,
  });
  const stepUp = StepUpCommandSchema.parse({
    action: "operator_credentials_change",
    password: input.currentPassword,
    requestDigest: await sha256(serializeCredentialChangeCommand(command)),
    targetId: input.session.operator.id,
  });
  const stepUpResponse = await fetch("/auth/step-up", {
    body: JSON.stringify(stepUp),
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    method: "POST",
    signal: signal ?? null,
  });
  const proof = await requireJson(stepUpResponse, StepUpProofSchema, "step-up proof");
  const changeResponse = await fetch("/api/v1/operator/credentials", {
    body: serializeCredentialChangeCommand(command),
    credentials: "same-origin",
    headers: authenticatedMutationHeaders({ "X-Kestrel-Step-Up": proof.proof }),
    method: "POST",
    signal: signal ?? null,
  });
  await requireNoContent(changeResponse, "credential-change response");
}

export async function runDiagnostic(signal?: AbortSignal): Promise<DiagnosticAccepted> {
  const response = await fetch("/api/v1/installation/diagnostics", {
    body: "{}",
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
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
