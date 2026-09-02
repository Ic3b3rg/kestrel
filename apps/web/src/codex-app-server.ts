import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";

import { z } from "zod";

import {
  CodexChatGptPlanSchema,
  CodexSubscriptionConnectionSchema,
  type CodexSubscriptionConnection,
  type CodexSubscriptionConnectionReason,
  type CodexSubscriptionUsage,
} from "@kestrel/contracts";

const CLIENT_NAME = "kestrel";
const CLIENT_VERSION = "0.0.0";
const DEFAULT_ARGUMENTS = ["app-server", "--stdio"] as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const PROCESS_STOP_TIMEOUT_MS = 1_000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const MINIMUM_CODEX_MINOR_VERSION = 152;

const InitializeResultSchema = z.object({
  codexHome: z.string().min(1),
  platformFamily: z.literal("unix"),
  platformOs: z.literal("macos"),
  userAgent: z.string().min(1).max(512),
});
const AccountResultSchema = z.object({
  account: z
    .union([
      z.object({
        type: z.literal("chatgpt"),
        email: z.email().max(320).nullable(),
        planType: CodexChatGptPlanSchema,
      }),
      z.object({ type: z.enum(["apiKey", "amazonBedrock"]) }),
    ])
    .nullable(),
  requiresOpenaiAuth: z.boolean(),
});
const ModelListResultSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        displayName: z.string().min(1).max(128),
        hidden: z.literal(false),
        isDefault: z.boolean(),
      }),
    )
    .max(100),
  nextCursor: z.string().min(1).max(512).nullable().optional(),
});
const RateLimitWindowSchema = z.object({
  usedPercent: z.number().int().min(0).max(100),
  windowDurationMins: z.number().int().positive().max(525_600).nullable().optional(),
  resetsAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
});
const RateLimitsResultSchema = z.object({
  rateLimits: z.object({
    planType: CodexChatGptPlanSchema.nullable().optional(),
    primary: RateLimitWindowSchema.nullable().optional(),
    secondary: RateLimitWindowSchema.nullable().optional(),
    rateLimitReachedType: z
      .enum([
        "rate_limit_reached",
        "workspace_owner_credits_depleted",
        "workspace_member_credits_depleted",
        "workspace_owner_usage_limit_reached",
        "workspace_member_usage_limit_reached",
      ])
      .nullable()
      .optional(),
    spendControlReached: z.boolean().nullable().optional(),
  }),
});

type CodexAppServerErrorKind =
  | "cancelled"
  | "crashed"
  | "invalid_response"
  | "timeout"
  | "unavailable"
  | "unsupported_protocol"
  | "unsupported_version";
type IncompleteProbeReason = Exclude<
  CodexSubscriptionConnectionReason,
  "usage_limit_reached" | "waiting_for_usage_reset"
>;

export class CodexAppServerError extends Error {
  constructor(public readonly kind: CodexAppServerErrorKind) {
    super(`Codex App Server probe failed: ${kind}`);
    this.name = "CodexAppServerError";
  }
}

interface CodexAppServerOptions {
  executable?: string;
  arguments?: readonly string[];
  timeoutMs?: number;
}

export interface CodexAgentRuntimePort {
  readConnection(signal?: AbortSignal): Promise<CodexSubscriptionConnection>;
}

interface PendingResponse {
  id: number;
  invalidResponseKind: "invalid_response" | "unsupported_protocol";
  resolve(value: unknown): void;
  reject(error: CodexAppServerError): void;
  schema: z.ZodType;
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LANG: "C", LC_ALL: "C", NO_COLOR: "1" };
  for (const name of ["HOME", "PATH", "CODEX_HOME", "XDG_CONFIG_HOME"] as const) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function killProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if its process group has already stopped.
    }
  }
  child.kill(signal);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

class AppServerSession {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #closed: Promise<void>;
  readonly #lines;
  readonly #timeout: NodeJS.Timeout;
  readonly #signal: AbortSignal | undefined;
  #closing = false;
  #failure: CodexAppServerError | null = null;
  #pending: PendingResponse | null = null;
  #stdoutBytes = 0;
  #stderrBytes = 0;

  constructor(
    executable: string,
    args: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    this.#signal = signal;
    this.#child = spawn(executable, args, {
      cwd: tmpdir(),
      detached: process.platform !== "win32",
      env: safeEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#closed = new Promise((resolve) => this.#child.once("close", () => resolve()));
    this.#lines = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    this.#timeout = setTimeout(() => this.#fail(new CodexAppServerError("timeout")), timeoutMs);
    this.#timeout.unref();

    this.#child.once("error", () => this.#fail(new CodexAppServerError("unavailable")));
    this.#child.once("close", () => {
      if (!this.#closing && this.#failure === null) {
        this.#fail(new CodexAppServerError("crashed"));
      }
    });
    this.#child.stdout.on("data", (chunk: Buffer) => {
      this.#stdoutBytes += chunk.byteLength;
      if (this.#stdoutBytes > MAX_STDOUT_BYTES) {
        this.#fail(new CodexAppServerError("invalid_response"));
      }
    });
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrBytes += chunk.byteLength;
      if (this.#stderrBytes > MAX_STDERR_BYTES) {
        this.#fail(new CodexAppServerError("invalid_response"));
      }
    });
    this.#lines.on("line", (line) => this.#receive(line));
    this.#lines.once("error", () => this.#fail(new CodexAppServerError("invalid_response")));
    signal?.addEventListener("abort", this.#onAbort, { once: true });
    if (signal?.aborted) this.#onAbort();
  }

  #onAbort = (): void => {
    this.#fail(new CodexAppServerError("cancelled"));
  };

  #fail(error: CodexAppServerError): void {
    if (this.#failure !== null) return;
    this.#failure = error;
    this.#pending?.reject(error);
    this.#pending = null;
    killProcessGroup(this.#child, "SIGKILL");
  }

  #receive(line: string): void {
    if (Buffer.byteLength(line, "utf8") > MAX_STDOUT_BYTES) {
      this.#fail(new CodexAppServerError("invalid_response"));
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#fail(new CodexAppServerError("invalid_response"));
      return;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      this.#fail(new CodexAppServerError("invalid_response"));
      return;
    }
    const record = message as Record<string, unknown>;
    if (!("id" in record)) {
      if (typeof record.method !== "string") {
        this.#fail(new CodexAppServerError("invalid_response"));
      }
      return;
    }
    const pending = this.#pending;
    if (pending === null || record.id !== pending.id || "result" in record === "error" in record) {
      this.#fail(new CodexAppServerError("invalid_response"));
      return;
    }
    if ("error" in record) {
      pending.reject(new CodexAppServerError(pending.invalidResponseKind));
      this.#pending = null;
      return;
    }
    const parsed = pending.schema.safeParse(record.result);
    if (!parsed.success) {
      pending.reject(new CodexAppServerError(pending.invalidResponseKind));
      this.#pending = null;
      return;
    }
    this.#pending = null;
    pending.resolve(parsed.data);
  }

  async request<T>(
    id: number,
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    invalidResponseKind: PendingResponse["invalidResponseKind"] = "invalid_response",
  ): Promise<T> {
    if (this.#failure !== null) throw this.#failure;
    if (this.#pending !== null) throw new CodexAppServerError("invalid_response");
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending = { id, invalidResponseKind, resolve, reject, schema };
    });
    this.#send({ id, method, params });
    return (await response) as T;
  }

  notify(method: string, params: unknown): void {
    if (this.#failure !== null) throw this.#failure;
    this.#send({ method, params });
  }

  #send(message: unknown): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error !== null && error !== undefined) {
        this.#fail(new CodexAppServerError("crashed"));
      }
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    clearTimeout(this.#timeout);
    this.#signal?.removeEventListener("abort", this.#onAbort);
    this.#child.stdin.end();
    const closedNormally = await Promise.race([
      this.#closed.then(() => true),
      delay(PROCESS_STOP_TIMEOUT_MS).then(() => false),
    ]);
    if (!closedNormally) {
      killProcessGroup(this.#child, "SIGTERM");
      const stopped = await Promise.race([
        this.#closed.then(() => true),
        delay(PROCESS_STOP_TIMEOUT_MS).then(() => false),
      ]);
      if (!stopped) killProcessGroup(this.#child, "SIGKILL");
    }
    await this.#closed;
    this.#lines.close();
  }
}

function readCodexVersion(userAgent: string): { supported: boolean; version: string } {
  const match = /^kestrel\/(\d+)\.(\d+)\.([0-9A-Za-z.+-]+)(?:\s|$)/u.exec(userAgent);
  const major = match?.[1];
  const minor = match?.[2];
  const patch = match?.[3];
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new CodexAppServerError("unsupported_protocol");
  }
  const supported = Number(major) > 0 || Number(minor) >= MINIMUM_CODEX_MINOR_VERSION;
  return { supported, version: `${major}.${minor}.${patch}` };
}

function mapWindow(window: z.infer<typeof RateLimitWindowSchema> | null | undefined) {
  if (window == null) return null;
  const resetsAt = window.resetsAt;
  return {
    usedPercent: window.usedPercent,
    windowDurationMinutes: window.windowDurationMins ?? null,
    resetsAt: resetsAt == null ? null : new Date(resetsAt * 1_000).toISOString(),
  };
}

function normalizeUsage(
  rateLimits: z.infer<typeof RateLimitsResultSchema>["rateLimits"],
): CodexSubscriptionUsage {
  const primary = mapWindow(rateLimits.primary);
  const secondary = mapWindow(rateLimits.secondary);
  const reachedType = rateLimits.rateLimitReachedType;
  const actionRequired =
    rateLimits.spendControlReached === true ||
    reachedType === "workspace_owner_credits_depleted" ||
    reachedType === "workspace_member_credits_depleted" ||
    reachedType === "workspace_owner_usage_limit_reached" ||
    reachedType === "workspace_member_usage_limit_reached";
  const waiting =
    reachedType === "rate_limit_reached" ||
    primary?.usedPercent === 100 ||
    secondary?.usedPercent === 100;
  return {
    availability: actionRequired
      ? "usage_limit_reached_action_required"
      : waiting
        ? "waiting_for_usage_reset"
        : "available",
    primary,
    secondary,
  };
}

function failedConnection(
  reason: IncompleteProbeReason,
  cli: CodexSubscriptionConnection["cli"] = null,
): CodexSubscriptionConnection {
  const state =
    reason === "timed_out" || reason === "unexpected_response" ? "unavailable" : "action_required";
  return CodexSubscriptionConnectionSchema.parse({
    schemaVersion: 1,
    state,
    reason,
    cli,
    account: null,
    models: [],
    usage: null,
    checkedAt: new Date().toISOString(),
  });
}

function failureReason(error: unknown): IncompleteProbeReason {
  if (!(error instanceof CodexAppServerError)) return "unexpected_response";
  switch (error.kind) {
    case "unavailable":
      return "cli_not_installed";
    case "unsupported_version":
      return "cli_version_unsupported";
    case "unsupported_protocol":
      return "protocol_unsupported";
    case "timeout":
      return "timed_out";
    case "crashed":
    case "invalid_response":
      return "unexpected_response";
    case "cancelled":
      throw error;
  }
}

export function createCodexAppServerAgentRuntime(
  options: CodexAppServerOptions = {},
): CodexAgentRuntimePort {
  const executable = options.executable ?? process.env.KESTREL_CODEX_EXECUTABLE ?? "codex";
  const args = options.arguments ?? DEFAULT_ARGUMENTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async readConnection(signal) {
      const session = new AppServerSession(executable, args, timeoutMs, signal);
      let cli: CodexSubscriptionConnection["cli"] = null;
      try {
        const initialized = await session.request(
          0,
          "initialize",
          {
            clientInfo: { name: CLIENT_NAME, title: "Kestrel", version: CLIENT_VERSION },
          },
          InitializeResultSchema,
          "unsupported_protocol",
        );
        const version = readCodexVersion(initialized.userAgent);
        cli = { ...version, protocol: "app_server_v2" };
        if (!version.supported) throw new CodexAppServerError("unsupported_version");
        session.notify("initialized", {});

        const accountResult = await session.request(
          1,
          "account/read",
          { refreshToken: false },
          AccountResultSchema,
        );
        if (accountResult.account === null) {
          return failedConnection(
            accountResult.requiresOpenaiAuth
              ? "authentication_required"
              : "chatgpt_subscription_required",
            cli,
          );
        }
        if (accountResult.account.type !== "chatgpt") {
          return failedConnection("chatgpt_subscription_required", cli);
        }

        const modelResult = await session.request(
          2,
          "model/list",
          { includeHidden: false, limit: 100 },
          ModelListResultSchema,
        );
        const rateLimits = await session.request(
          3,
          "account/rateLimits/read",
          null,
          RateLimitsResultSchema,
        );
        if (modelResult.nextCursor != null || modelResult.data.length === 0) {
          throw new CodexAppServerError("invalid_response");
        }
        if (
          rateLimits.rateLimits.planType != null &&
          rateLimits.rateLimits.planType !== accountResult.account.planType
        ) {
          throw new CodexAppServerError("invalid_response");
        }
        const usage = normalizeUsage(rateLimits.rateLimits);
        const reason =
          usage.availability === "waiting_for_usage_reset"
            ? ("waiting_for_usage_reset" as const)
            : usage.availability === "usage_limit_reached_action_required"
              ? ("usage_limit_reached" as const)
              : null;
        return CodexSubscriptionConnectionSchema.parse({
          schemaVersion: 1,
          state:
            reason === null
              ? "ready"
              : reason === "waiting_for_usage_reset"
                ? "waiting_for_usage_reset"
                : "action_required",
          reason,
          cli,
          account: {
            authentication: "chatgpt",
            email: accountResult.account.email,
            plan: accountResult.account.planType,
          },
          models: modelResult.data.map(({ id, displayName, isDefault }) => ({
            id,
            displayName,
            isDefault,
          })),
          usage,
          checkedAt: new Date().toISOString(),
        });
      } catch (error) {
        return failedConnection(failureReason(error), cli);
      } finally {
        await session.close();
      }
    },
  };
}
