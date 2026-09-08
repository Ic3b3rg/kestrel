import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";

import {
  CodexFactoryTransport,
  CodexFactoryError,
  record,
  boundedString,
  inputQuestion,
  protocolError,
} from "./codex-factory-transport.js";

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

export class CodexPlanningError extends CodexFactoryError {
  constructor(code: CodexPlanningErrorCode, question?: string) {
    super(code, question);
    this.message = `Codex planning failed: ${code}`;
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

const MAX_ANSWER_BYTES = 128 * 1024;
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

class PlanningSession {
  readonly #transport: CodexFactoryTransport;
  #turnCompleted = false;
  #threadId: string | undefined;
  #turnId: string | undefined;
  #finalText: string | undefined;
  #legacyText: string | undefined;
  #resolveTurn!: (value: PlanningTurnResult) => void;
  readonly #turnResult: Promise<PlanningTurnResult>;

  constructor(options: CodexPlanningOptions, timeoutMs: number, signal?: AbortSignal) {
    this.#turnResult = new Promise((resolve) => {
      this.#resolveTurn = resolve;
    });
    this.#transport = new CodexFactoryTransport({
      executable: options.executable ?? "codex",
      arguments: [
        ...(options.arguments ?? ["app-server", "--listen", "stdio://"]),
        ...SAFETY_ARGUMENTS,
      ],
      cwd: tmpdir(),
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
      receive: (message) => this.#receive(message),
    });
  }

  guard<T>(operation: Promise<T>): Promise<T> {
    return this.#transport.guard(operation);
  }
  notify(method: string, params?: unknown): void {
    this.#transport.notify(method, params);
  }
  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    return this.#transport.request(method, params);
  }

  #receive(message: Record<string, unknown>): void {
    if ("id" in message && "method" in message) {
      this.#rejectServerRequest(message);
      return;
    }
    const method = boundedString(message.method);
    if (
      ["error", "turn/started", "turn/completed", "item/completed", "item/started"].includes(method)
    )
      this.#receiveTurnEvent(method, record(message.params));
  }

  #rejectServerRequest(message: Record<string, unknown>): void {
    if (typeof message.id !== "string" && typeof message.id !== "number")
      throw new CodexPlanningError("invalid_response");
    switch (message.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        this.#transport.send({ id: message.id, result: { decision: "cancel" } });
        throw new CodexPlanningError("permission_required");
      case "item/permissions/requestApproval":
        this.#transport.send({ id: message.id, result: { permissions: {}, scope: "turn" } });
        throw new CodexPlanningError("permission_required");
      case "mcpServer/elicitation/request":
        this.#transport.send({ id: message.id, result: { action: "cancel" } });
        throw new CodexPlanningError("permission_required");
      case "item/tool/requestUserInput": {
        const params = record(message.params);
        this.#observeTurn(params.threadId, params.turnId);
        const question = inputQuestion(params);
        this.#transport.send({ id: message.id, result: { answers: {} } });
        throw new CodexPlanningError("input_required", question);
      }
      default:
        this.#transport.send({
          id: message.id,
          error: { code: -32601, message: "Unsupported request" },
        });
        throw new CodexPlanningError("invalid_response");
    }
  }

  #observeTurn(threadId: unknown, turnId: unknown): string {
    const id = boundedString(turnId);
    if (threadId !== this.#threadId || (this.#turnId !== undefined && id !== this.#turnId)) {
      throw new CodexPlanningError("invalid_response");
    }
    this.#turnId = id;
    this.#transport.started();
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
      this.#transport.completed();
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
    await this.#transport.close(
      this.#threadId !== undefined && this.#turnId !== undefined && !this.#turnCompleted
        ? {
            method: "turn/interrupt",
            params: { threadId: this.#threadId, turnId: this.#turnId },
          }
        : undefined,
    );
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
      boundedString(input.prompt, 512 * 1024);
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
        throw error instanceof CodexFactoryError
          ? new CodexPlanningError(error.code, error.question)
          : new CodexPlanningError("unavailable");
      } finally {
        await session?.close();
      }
    },
  };
}
