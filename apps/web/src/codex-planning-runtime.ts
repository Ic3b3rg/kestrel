import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";

export type CodexPlanningErrorCode =
  | "unavailable"
  | "authentication"
  | "usage_limit"
  | "permission_required"
  | "input_required"
  | "timeout"
  | "cancelled"
  | "interrupted"
  | "invalid_response";

export class CodexPlanningError extends Error {
  constructor(
    public readonly code: CodexPlanningErrorCode,
    public readonly question?: string,
  ) {
    super(`Codex planning failed: ${code}`);
    this.name = "CodexPlanningError";
  }
}

interface CodexPlanningOptions {
  executable?: string;
  arguments?: readonly string[];
  timeoutMs?: number;
}

interface PlanningTurnInput {
  cwd: string;
  threadId?: string;
  model: string;
  prompt: string;
  requestId: string;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  onThread(threadId: string): Promise<void>;
}

interface PlanningTurnResult {
  threadId: string;
  turnId: string;
  text: string;
}

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_ANSWER_BYTES = 128 * 1024;
const STOP_TIMEOUT_MS = 250;
const DISABLED_FEATURES = [
  "apps",
  "plugins",
  "hooks",
  "browser_use",
  "browser_use_external",
  "shell_tool",
] as const;
const FEATURES = Object.fromEntries(DISABLED_FEATURES.map((name) => [name, false]));
const CONFIG = { features: FEATURES, web_search: "disabled", allow_login_shell: false };
const SAFETY_ARGUMENTS = [
  "--strict-config",
  ...DISABLED_FEATURES.flatMap((name) => ["--disable", name]),
  "-c",
  'web_search="disabled"',
  "-c",
  "allow_login_shell=false",
  "-c",
  'sandbox_mode="read-only"',
  "-c",
  'approval_policy="never"',
  "-c",
  'approvals_reviewer="user"',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new CodexPlanningError("invalid_response");
  return value;
}

function boundedString(value: unknown, limit = 256): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > limit) {
    throw new CodexPlanningError("invalid_response");
  }
  return value;
}

function inputQuestion(params: Record<string, unknown>): string {
  if (
    !Array.isArray(params.questions) ||
    params.questions.length < 1 ||
    params.questions.length > 3
  ) {
    throw new CodexPlanningError("invalid_response");
  }
  const questions = params.questions.map((value) => {
    const question = record(value);
    if (question.isSecret === true)
      return "Codex requested sensitive input. Configure its authentication directly before retrying.";
    const text = boundedString(question.question, 1_024);
    if (question.options == null) return text;
    if (!Array.isArray(question.options) || question.options.length > 8)
      throw new CodexPlanningError("invalid_response");
    const options = question.options.map((value) => {
      const option = record(value);
      return `- ${boundedString(option.label, 128)}: ${boundedString(option.description, 512)}`;
    });
    return [text, ...options].join("\n");
  });
  return boundedString(questions.join("\n\n"), 4_096);
}

function protocolError(value: unknown): CodexPlanningError {
  const error = isRecord(value) ? value : {};
  const data = isRecord(error.data) ? error.data : {};
  const info = error.codexErrorInfo ?? data.codexErrorInfo;
  const details = isRecord(info) ? Object.values(info).find(isRecord) : undefined;
  const status = details?.httpStatusCode ?? error.code;
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  if (
    info === "unauthorized" ||
    status === 401 ||
    /not logged in|unauthenticated|authentication|unauthorized/u.test(message)
  ) {
    return new CodexPlanningError("authentication");
  }
  if (
    info === "usageLimitExceeded" ||
    info === "rateLimitExceeded" ||
    info === "sessionBudgetExceeded" ||
    status === 429 ||
    /usage limit|rate limit|quota|credits? exhausted/u.test(message)
  ) {
    return new CodexPlanningError("usage_limit");
  }
  if (info === "sandboxError" || /approval|permission|sandbox/u.test(message)) {
    return new CodexPlanningError("permission_required");
  }
  return new CodexPlanningError("unavailable");
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LANG: "C", LC_ALL: "C", NO_COLOR: "1" };
  for (const name of ["HOME", "PATH", "CODEX_HOME", "XDG_CONFIG_HOME"] as const) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function killGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may already have exited; still stop the direct child if present.
    }
  }
  child.kill(signal);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class PlanningSession {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #closed: Promise<void>;
  readonly #failed: Promise<never>;
  readonly #timeout: NodeJS.Timeout;
  readonly #decoder = new StringDecoder("utf8");
  readonly #signal: AbortSignal | undefined;
  #rejectFailure!: (error: CodexPlanningError) => void;
  #failure: CodexPlanningError | null = null;
  #pending: { id: number; resolve(value: unknown): void } | null = null;
  #nextId = 1;
  #buffer = "";
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #closing = false;
  #turnCompleted = false;
  #threadId: string | undefined;
  #turnId: string | undefined;
  #finalText: string | undefined;
  #legacyText: string | undefined;
  #resolveTurn!: (value: PlanningTurnResult) => void;
  readonly #turnResult: Promise<PlanningTurnResult>;

  constructor(options: CodexPlanningOptions, timeoutMs: number, signal?: AbortSignal) {
    this.#signal = signal;
    this.#failed = new Promise((_, reject) => {
      this.#rejectFailure = reject;
    });
    void this.#failed.catch(() => undefined);
    this.#turnResult = new Promise((resolve) => {
      this.#resolveTurn = resolve;
    });
    this.#child = spawn(
      options.executable ?? "codex",
      [...(options.arguments ?? ["app-server", "--listen", "stdio://"]), ...SAFETY_ARGUMENTS],
      {
        cwd: tmpdir(),
        env: safeEnvironment(),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.#closed = new Promise((resolve) => this.#child.once("close", () => resolve()));
    this.#child.once("error", () => this.#fail(new CodexPlanningError("unavailable")));
    this.#child.once("close", () => {
      if (!this.#closing && !this.#turnCompleted) {
        this.#fail(
          new CodexPlanningError(this.#turnId === undefined ? "unavailable" : "interrupted"),
        );
      }
    });
    this.#child.stdin.on("error", () => this.#fail(new CodexPlanningError("unavailable")));
    this.#child.stdout.on("data", (chunk: Buffer) => this.#receiveChunk(chunk));
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrBytes += chunk.byteLength;
      if (this.#stderrBytes > MAX_STDERR_BYTES)
        this.#fail(new CodexPlanningError("invalid_response"));
    });
    this.#timeout = setTimeout(() => this.#fail(new CodexPlanningError("timeout")), timeoutMs);
    signal?.addEventListener("abort", this.#onAbort, { once: true });
    if (signal?.aborted) this.#onAbort();
  }

  #onAbort = (): void => {
    this.#fail(new CodexPlanningError("cancelled"));
  };

  #fail(error: CodexPlanningError): void {
    if (this.#failure !== null || this.#closing) return;
    this.#failure = error;
    this.#rejectFailure(error);
    this.#pending = null;
  }

  async guard<T>(operation: Promise<T>): Promise<T> {
    if (this.#failure !== null) throw this.#failure;
    return Promise.race([operation, this.#failed]);
  }

  #send(message: unknown): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) this.#fail(new CodexPlanningError("unavailable"));
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#failure !== null) throw this.#failure;
    this.#send({ method, params });
  }

  async request(method: string, params: unknown): Promise<Record<string, unknown>> {
    if (this.#failure !== null) throw this.#failure;
    if (this.#pending !== null) throw new CodexPlanningError("invalid_response");
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve) => {
      this.#pending = { id, resolve };
    });
    this.#send({ id, method, params });
    return record(await this.guard(response));
  }

  #receiveChunk(chunk: Buffer): void {
    if (this.#failure !== null || this.#closing) return;
    this.#stdoutBytes += chunk.byteLength;
    if (this.#stdoutBytes > MAX_STDOUT_BYTES)
      return this.#fail(new CodexPlanningError("invalid_response"));
    this.#buffer += this.#decoder.write(chunk);
    let newline: number;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES)
        return this.#fail(new CodexPlanningError("invalid_response"));
      try {
        this.#receive(record(JSON.parse(line)));
      } catch (error) {
        return this.#fail(
          error instanceof CodexPlanningError ? error : new CodexPlanningError("invalid_response"),
        );
      }
    }
    if (Buffer.byteLength(this.#buffer) > MAX_FRAME_BYTES)
      this.#fail(new CodexPlanningError("invalid_response"));
  }

  #receive(message: Record<string, unknown>): void {
    if ("id" in message && "method" in message) {
      this.#rejectServerRequest(message);
      return;
    }
    if ("id" in message) {
      const pending = this.#pending;
      if (
        pending === null ||
        message.id !== pending.id ||
        "result" in message === "error" in message
      ) {
        throw new CodexPlanningError("invalid_response");
      }
      this.#pending = null;
      if ("error" in message) throw protocolError(message.error);
      pending.resolve(message.result);
      return;
    }
    const method = boundedString(message.method);
    if (
      method === "error" ||
      method === "turn/started" ||
      method === "turn/completed" ||
      method === "item/completed" ||
      method === "item/started"
    ) {
      this.#receiveTurnEvent(method, record(message.params));
    }
  }

  #rejectServerRequest(message: Record<string, unknown>): void {
    if (typeof message.id !== "string" && typeof message.id !== "number")
      throw new CodexPlanningError("invalid_response");
    switch (message.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        this.#send({ id: message.id, result: { decision: "cancel" } });
        throw new CodexPlanningError("permission_required");
      case "item/permissions/requestApproval":
        this.#send({ id: message.id, result: { permissions: {}, scope: "turn" } });
        throw new CodexPlanningError("permission_required");
      case "mcpServer/elicitation/request":
        this.#send({ id: message.id, result: { action: "cancel" } });
        throw new CodexPlanningError("permission_required");
      case "item/tool/requestUserInput": {
        const params = record(message.params);
        this.#observeTurn(params.threadId, params.turnId);
        const question = inputQuestion(params);
        this.#send({ id: message.id, result: { answers: {} } });
        throw new CodexPlanningError("input_required", question);
      }
      default:
        this.#send({ id: message.id, error: { code: -32601, message: "Unsupported request" } });
        throw new CodexPlanningError("invalid_response");
    }
  }

  #observeTurn(threadId: unknown, turnId: unknown): string {
    const id = boundedString(turnId);
    if (threadId !== this.#threadId || (this.#turnId !== undefined && id !== this.#turnId)) {
      throw new CodexPlanningError("invalid_response");
    }
    this.#turnId = id;
    return id;
  }

  #readItem(value: unknown, completed: boolean): void {
    const item = record(value);
    const type = boundedString(item.type);
    if (!["agentMessage", "reasoning", "plan", "userMessage", "contextCompaction"].includes(type)) {
      throw new CodexPlanningError("permission_required");
    }
    if (type !== "agentMessage" || !completed) return;
    const text = boundedString(item.text, MAX_ANSWER_BYTES);
    if (item.phase === "final_answer") this.#finalText = text;
    else if (item.phase == null) this.#legacyText = text;
    else if (item.phase !== "commentary") throw new CodexPlanningError("invalid_response");
  }

  #receiveTurnEvent(method: string, params: Record<string, unknown>): void {
    if (method === "turn/started" || method === "turn/completed") {
      const turn = record(params.turn);
      const turnId = this.#observeTurn(params.threadId, turn.id);
      if (method === "turn/started") return;
      if (turn.status === "interrupted") throw new CodexPlanningError("interrupted");
      if (turn.status === "failed") throw protocolError(turn.error);
      if (turn.status !== "completed" || (turn.error !== undefined && turn.error !== null))
        throw new CodexPlanningError("invalid_response");
      if (Array.isArray(turn.items)) for (const item of turn.items) this.#readItem(item, true);
      const text = this.#finalText ?? this.#legacyText;
      if (text === undefined || this.#threadId === undefined)
        throw new CodexPlanningError("invalid_response");
      this.#turnCompleted = true;
      this.#resolveTurn({ threadId: this.#threadId, turnId, text });
      return;
    }
    this.#observeTurn(params.threadId, params.turnId);
    if (method === "error") {
      const error = protocolError(params.error);
      if (params.willRetry !== true || error.code !== "unavailable") throw error;
      return;
    }
    this.#readItem(params.item, method === "item/completed");
  }

  async turn(input: PlanningTurnInput, cwd: string, threadId: string): Promise<PlanningTurnResult> {
    this.#threadId = threadId;
    const response = await this.request("turn/start", {
      threadId,
      cwd,
      model: input.model,
      clientUserMessageId: input.requestId,
      input: [{ type: "text", text: input.prompt }],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    });
    this.#observeTurn(threadId, record(response.turn).id);
    return this.guard(this.#turnResult);
  }

  async close(): Promise<void> {
    this.#closing = true;
    clearTimeout(this.#timeout);
    this.#signal?.removeEventListener("abort", this.#onAbort);
    if (this.#threadId !== undefined && this.#turnId !== undefined && !this.#turnCompleted) {
      this.#send({
        id: this.#nextId++,
        method: "turn/interrupt",
        params: { threadId: this.#threadId, turnId: this.#turnId },
      });
    }
    this.#child.stdin.end();
    await Promise.race([this.#closed, delay(STOP_TIMEOUT_MS)]);
    killGroup(this.#child, "SIGTERM");
    await Promise.race([this.#closed, delay(STOP_TIMEOUT_MS)]);
    killGroup(this.#child, "SIGKILL");
    await Promise.race([this.#closed, delay(STOP_TIMEOUT_MS)]);
    this.#child.stdin.destroy();
    this.#child.stdout.destroy();
    this.#child.stderr.destroy();
    this.#child.unref();
  }
}

function disabledMcpServers(response: Record<string, unknown>): Record<string, unknown> {
  const config = record(response.config);
  const features = record(config.features);
  if (
    DISABLED_FEATURES.some((name) => features[name] !== false) ||
    config.web_search !== "disabled" ||
    config.allow_login_shell !== false
  ) {
    throw new CodexPlanningError("permission_required");
  }
  const names = Object.keys(config.mcp_servers === undefined ? {} : record(config.mcp_servers));
  if (names.length > 256) throw new CodexPlanningError("invalid_response");
  return Object.fromEntries(names.map((name) => [boundedString(name), { enabled: false }]));
}

function verifiedThread(
  response: Record<string, unknown>,
  cwd: string,
  model: string,
  requestedId?: string,
): string {
  const id = boundedString(record(response.thread).id);
  if (response.model !== model || response.modelProvider !== "openai")
    throw new CodexPlanningError("invalid_response");
  const sandbox = record(response.sandbox);
  if (
    (requestedId !== undefined && id !== requestedId) ||
    response.cwd !== cwd ||
    response.approvalPolicy !== "never" ||
    response.approvalsReviewer !== "user" ||
    sandbox.type !== "readOnly" ||
    (sandbox.networkAccess ?? false) !== false ||
    Object.keys(sandbox).some((key) => key !== "type" && key !== "networkAccess")
  ) {
    throw new CodexPlanningError("permission_required");
  }
  return id;
}

export function createCodexPlanningRuntime(options: CodexPlanningOptions = {}) {
  return {
    async runTurn(input: PlanningTurnInput): Promise<PlanningTurnResult> {
      const timeoutMs = options.timeoutMs ?? 120_000;
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 1_800_000 ||
        !isAbsolute(input.cwd)
      )
        throw new CodexPlanningError("invalid_response");
      boundedString(input.model, 128);
      boundedString(input.requestId);
      boundedString(input.prompt, 256 * 1024);
      if (input.threadId !== undefined) boundedString(input.threadId);
      if (input.signal?.aborted) throw new CodexPlanningError("cancelled");
      let session: PlanningSession | undefined;
      try {
        const cwd = await realpath(input.cwd);
        if (
          input.outputSchema !== undefined &&
          Buffer.byteLength(JSON.stringify(input.outputSchema)) > 64 * 1024
        )
          throw new CodexPlanningError("invalid_response");
        session = new PlanningSession(options, timeoutMs, input.signal);
        const initialized = await session.request("initialize", {
          clientInfo: { name: "kestrel", version: "0.0.0" },
        });
        boundedString(initialized.userAgent, 512);
        session.notify("initialized");
        const mcpServers = disabledMcpServers(
          await session.request("config/read", { cwd, includeLayers: false }),
        );
        const thread = await session.request(
          input.threadId === undefined ? "thread/start" : "thread/resume",
          {
            cwd,
            model: input.model,
            modelProvider: "openai",
            sandbox: "read-only",
            approvalPolicy: "never",
            approvalsReviewer: "user",
            config: { ...CONFIG, model_provider: "openai", mcp_servers: mcpServers },
            developerInstructions:
              "Plan using only the source material supplied in the prompt. Do not use tools, modify files, or perform external actions. Ask planning questions in your answer.",
            ...(input.threadId === undefined
              ? {}
              : { threadId: input.threadId, excludeTurns: true }),
          },
        );
        const threadId = verifiedThread(thread, cwd, input.model, input.threadId);
        await session.guard(input.onThread(threadId));
        return await session.turn(input, cwd, threadId);
      } catch (error) {
        throw error instanceof CodexPlanningError ? error : new CodexPlanningError("unavailable");
      } finally {
        await session?.close();
      }
    },
  };
}
