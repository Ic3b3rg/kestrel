import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type CodexFactoryErrorCode =
  | "unavailable"
  | "authentication"
  | "usage_limit"
  | "permission_required"
  | "input_required"
  | "timeout"
  | "cancelled"
  | "interrupted"
  | "invalid_response";

export class CodexFactoryError extends Error {
  constructor(
    public readonly code: CodexFactoryErrorCode,
    public readonly question?: string,
  ) {
    super(`Codex factory failed: ${code}`);
    this.name = "CodexFactoryError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new CodexFactoryError("invalid_response");
  return value;
}

export function boundedString(value: unknown, limit = 256): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > limit) {
    throw new CodexFactoryError("invalid_response");
  }
  return value;
}

export function inputQuestion(params: Record<string, unknown>): string {
  if (
    !Array.isArray(params.questions) ||
    params.questions.length < 1 ||
    params.questions.length > 3
  ) {
    throw new CodexFactoryError("invalid_response");
  }
  const questions = params.questions.map((value) => {
    const question = record(value);
    if (question.isSecret === true)
      return "Codex requested sensitive input. Configure its authentication directly before retrying.";
    const text = boundedString(question.question, 1_024);
    if (question.options == null) return text;
    if (!Array.isArray(question.options) || question.options.length > 8)
      throw new CodexFactoryError("invalid_response");
    const options = question.options.map((value) => {
      const option = record(value);
      return `- ${boundedString(option.label, 128)}: ${boundedString(option.description, 512)}`;
    });
    return [text, ...options].join("\n");
  });
  return boundedString(questions.join("\n\n"), 4_096);
}

export function protocolError(value: unknown): CodexFactoryError {
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
    return new CodexFactoryError("authentication");
  }
  if (
    info === "usageLimitExceeded" ||
    info === "rateLimitExceeded" ||
    info === "sessionBudgetExceeded" ||
    status === 429 ||
    /usage limit|rate limit|quota|credits? exhausted/u.test(message)
  ) {
    return new CodexFactoryError("usage_limit");
  }
  if (info === "sandboxError" || /approval|permission|sandbox/u.test(message)) {
    return new CodexFactoryError("permission_required");
  }
  return new CodexFactoryError("unavailable");
}

export function safeEnvironment(): NodeJS.ProcessEnv {
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

const profiles = {
  connection: { stdoutBytes: 2 * 1024 * 1024, stderrBytes: 32 * 1024, stopMs: 1_000, initialId: 0 },
  turn: { stdoutBytes: 4 * 1024 * 1024, stderrBytes: 64 * 1024, stopMs: 250, initialId: 1 },
} as const;

// Shared bounded stdio framing; authority and turn interpretation stay with each runtime.
export class CodexAppServerTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #closed: Promise<void>;
  readonly #processExited: Promise<void>;
  readonly #profile: keyof typeof profiles;
  readonly #failed: Promise<never>;
  readonly #timeout: NodeJS.Timeout;
  readonly #decoder = new StringDecoder("utf8");
  readonly #signal: AbortSignal | undefined;
  readonly #receive: (message: Record<string, unknown>) => void;
  #rejectFailure!: (error: Error) => void;
  #failure: Error | null = null;
  #pending: {
    id: number;
    resolve(value: unknown): void;
    protocolError(value: unknown): Error;
  } | null = null;
  #nextId = 1;
  #buffer = "";
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #closing = false;
  #exited = false;
  #operationStarted = false;
  #operationCompleted = false;

  constructor(options: {
    profile: keyof typeof profiles;
    executable: string;
    arguments: readonly string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
    receive(message: Record<string, unknown>): void;
  }) {
    this.#profile = options.profile;
    this.#nextId = profiles[options.profile].initialId;
    this.#signal = options.signal;
    this.#receive = (message) => options.receive(message);
    this.#failed = new Promise((_, reject) => {
      this.#rejectFailure = reject;
    });
    void this.#failed.catch(() => undefined);
    this.#child = spawn(options.executable, [...options.arguments], {
      cwd: options.cwd,
      env: options.env ?? safeEnvironment(),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#processExited = new Promise((resolve) => this.#child.once("exit", () => resolve()));
    this.#closed = new Promise((resolve) =>
      this.#child.once("close", () => {
        this.#exited = true;
        resolve();
      }),
    );
    this.#child.once("error", () => this.fail(new CodexFactoryError("unavailable")));
    this.#child.once("close", () => {
      if (!this.#closing && !this.#operationCompleted)
        this.fail(
          new CodexFactoryError(
            this.#profile === "connection"
              ? "invalid_response"
              : this.#operationStarted
                ? "interrupted"
                : "unavailable",
          ),
        );
    });
    this.#child.stdin.on("error", () =>
      this.fail(
        new CodexFactoryError(this.#profile === "connection" ? "invalid_response" : "unavailable"),
      ),
    );
    this.#child.stdout.on("data", (chunk: Buffer) => this.#receiveChunk(chunk));
    this.#child.stdout.on("end", () => {
      // The connection probe historically accepted readline's final EOF-delimited frame.
      if (this.#profile !== "connection" || this.#failure !== null || this.#closing) return;
      this.#buffer += this.#decoder.end();
      if (this.#buffer.length > 0) {
        this.#buffer += "\n";
        this.#receiveFrames();
      }
    });
    this.#child.stdout.on("error", () => this.fail(new CodexFactoryError("invalid_response")));
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrBytes += chunk.byteLength;
      if (this.#stderrBytes > profiles[this.#profile].stderrBytes)
        this.fail(new CodexFactoryError("invalid_response"));
    });
    this.#timeout = setTimeout(
      () => this.fail(new CodexFactoryError("timeout")),
      options.timeoutMs,
    );
    if (this.#profile === "connection") this.#timeout.unref();
    options.signal?.addEventListener("abort", this.#onAbort, { once: true });
    if (options.signal?.aborted) this.#onAbort();
  }

  #onAbort = (): void => {
    this.fail(new CodexFactoryError("cancelled"));
  };

  fail(error: Error): void {
    if (this.#failure !== null || this.#closing) return;
    this.#failure = error;
    this.#rejectFailure(error);
    this.#pending = null;
    if (this.#profile === "connection") killGroup(this.#child, "SIGKILL");
  }

  started(): void {
    this.#operationStarted = true;
  }
  completed(): void {
    this.#operationCompleted = true;
  }

  async guard<T>(operation: Promise<T>): Promise<T> {
    if (this.#failure !== null) {
      void operation.catch(() => undefined);
      throw this.#failure;
    }
    return Promise.race([operation, this.#failed]);
  }

  send(message: unknown): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error)
        this.fail(
          new CodexFactoryError(
            this.#profile === "connection" ? "invalid_response" : "unavailable",
          ),
        );
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#failure !== null) throw this.#failure;
    this.send({ method, params });
  }

  async request(
    method: string,
    params: unknown,
    mapProtocolError: (value: unknown) => Error = protocolError,
  ): Promise<unknown> {
    if (this.#failure !== null) throw this.#failure;
    if (this.#pending !== null) throw new CodexFactoryError("invalid_response");
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve) => {
      this.#pending = { id, resolve, protocolError: mapProtocolError };
    });
    this.send({ id, method, params });
    return this.guard(response);
  }

  #receiveChunk(chunk: Buffer): void {
    if (this.#failure !== null || this.#closing) return;
    this.#stdoutBytes += chunk.byteLength;
    if (this.#stdoutBytes > profiles[this.#profile].stdoutBytes)
      return this.fail(new CodexFactoryError("invalid_response"));
    this.#buffer += this.#decoder.write(chunk);
    this.#receiveFrames();
  }

  #receiveFrames(): void {
    let newline: number;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > 2 * 1024 * 1024)
        return this.fail(new CodexFactoryError("invalid_response"));
      try {
        const message = record(JSON.parse(line));
        if ("id" in message && !("method" in message)) {
          const pending = this.#pending;
          if (
            pending === null ||
            message.id !== pending.id ||
            "result" in message === "error" in message
          )
            throw new CodexFactoryError("invalid_response");
          this.#pending = null;
          if ("error" in message) throw pending.protocolError(message.error);
          pending.resolve(message.result);
        } else this.#receive(message);
      } catch (error) {
        return this.fail(
          error instanceof Error && !(error instanceof SyntaxError)
            ? error
            : new CodexFactoryError("invalid_response"),
        );
      }
    }
    if (Buffer.byteLength(this.#buffer) > 2 * 1024 * 1024)
      this.fail(new CodexFactoryError("invalid_response"));
  }

  // This reports only the App Server process. It is NOT proof that tool descendants stopped.
  async close(interrupt?: { method: string; params: unknown }): Promise<{ exited: boolean }> {
    this.#closing = true;
    clearTimeout(this.#timeout);
    this.#signal?.removeEventListener("abort", this.#onAbort);
    if (interrupt !== undefined) this.send({ id: this.#nextId++, ...interrupt });
    this.#child.stdin.end();
    const wait = () =>
      Promise.race([
        this.#closed.then(() => "closed" as const),
        ...(this.#profile === "connection"
          ? [this.#processExited.then(() => "exited" as const)]
          : []),
        delay(profiles[this.#profile].stopMs).then(() => "timeout" as const),
      ]);
    for (const signal of [null, "SIGTERM", "SIGKILL"] as const) {
      if (signal !== null) killGroup(this.#child, signal);
      const settlement = await wait();
      // A connection probe can outlive its parent through detached Codex helper pipes.
      // Turn sessions still terminate their group; Sandbox teardown is proved separately.
      if (this.#profile === "connection" && settlement !== "timeout") break;
    }
    this.#child.stdin.destroy();
    this.#child.stdout.destroy();
    this.#child.stderr.destroy();
    if (this.#profile === "connection")
      await Promise.race([this.#closed, delay(profiles.connection.stopMs)]);
    this.#child.unref();
    return { exited: this.#exited };
  }
}
