import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import {
  CodexFactoryError,
  CodexFactoryTransport,
  boundedString,
  inputQuestion,
  isRecord,
  protocolError,
  record,
  safeEnvironment,
  type CodexFactoryErrorCode,
} from "./codex-factory-transport.js";

export type CodexExecutionErrorCode =
  CodexFactoryErrorCode | "sandbox_unavailable" | "stop_unconfirmed";
export class CodexExecutionError extends Error {
  constructor(
    public readonly code: CodexExecutionErrorCode,
    public readonly question?: string,
    public readonly reason?: string,
  ) {
    super(`Codex execution failed: ${code}${reason === undefined ? "" : ` (${reason})`}`);
    this.name = "CodexExecutionError";
  }
}

export interface CodexExecutionActivity {
  itemId: string;
  kind: "message" | "command" | "file_change";
  state: "started" | "completed";
  summary: string;
}
export interface CodexExecutionQuestion {
  code: "input_required" | "permission_required";
  question: string;
}
export interface CodexExecutionLifecycle {
  beforeContainerCreate(name: string, daemonId?: string): Promise<void>;
  onContainer(container: { name: string; id: string }): Promise<void>;
  onStopped(container: { name: string; id: string | null }): Promise<void>;
}
export interface CodexExecutionTurnInput extends CodexExecutionLifecycle {
  cwd: string;
  gitDirectory?: string;
  model: string;
  prompt: string;
  requestId: string;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  onThread(threadId: string): Promise<void>;
  onTurn(turnId: string): Promise<void>;
  onActivity(activity: CodexExecutionActivity): Promise<void>;
  onQuestion(question: CodexExecutionQuestion): Promise<void>;
}
export interface CodexExecutionTurnResult {
  threadId: string;
  turnId: string;
  text: string;
}
export interface CodexVerificationInput extends CodexExecutionLifecycle {
  workspaceCwd: string;
  gitDirectory?: string;
  cwd: string;
  command: readonly string[];
  processId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface CodexVerificationResult {
  processId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}
export interface CodexExecutionRuntime {
  runTurn(input: CodexExecutionTurnInput): Promise<CodexExecutionTurnResult>;
  runVerification(input: CodexVerificationInput): Promise<CodexVerificationResult>;
}
interface Options {
  executable?: string;
  arguments?: readonly string[];
  timeoutMs?: number;
  dockerExecutable?: string;
  containerImage: string;
}
const DISABLED = [
  "apps",
  "plugins",
  "hooks",
  "browser_use",
  "browser_use_external",
  "in_app_browser",
  "multi_agent",
  "multi_agent_v2",
  "code_mode",
  "code_mode_only",
  "shell_snapshot",
  "shell_snapshot_v2",
];
const FEATURES = { ...Object.fromEntries(DISABLED.map((name) => [name, false])), shell_tool: true };
const SAFETY_ARGUMENTS = [
  "--strict-config",
  ...DISABLED.flatMap((name) => ["--disable", name]),
  "--enable",
  "shell_tool",
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
const ENVIRONMENTS = [
  { environmentId: "remote", cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
];
const OUTPUT_CAP = 64 * 1024;
const CONTAINER_INSPECT =
  '{"id":{{json .Id}},"name":{{json .Name}},"running":{{.State.Running}},"status":{{json .State.Status}},"exitCode":{{.State.ExitCode}},"image":{{json .Image}},"network":{{json .HostConfig.NetworkMode}},"readonly":{{.HostConfig.ReadonlyRootfs}},"privileged":{{.HostConfig.Privileged}},"pidMode":{{json .HostConfig.PidMode}},"restart":{{json .HostConfig.RestartPolicy.Name}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"mounts":{{json .Mounts}},"labels":{{json .Config.Labels}}}';
const FORWARD =
  "const n=require('node:net');const s=n.connect(8765,'127.0.0.1',()=>{process.stdin.pipe(s);s.pipe(process.stdout)});s.on('error',()=>process.exit(1));process.stdin.on('end',()=>s.end());";
// This fixed probe waits for the executor socket. It never runs project code.
const READY =
  "const n=require('node:net');let tries=0;function check(){const s=n.connect(8765,'127.0.0.1',()=>{s.destroy();process.exit(0)});s.on('error',()=>{s.destroy();if(++tries===40)process.exit(1);setTimeout(check,50)})}check();";

function executionError(error: unknown): CodexExecutionError {
  if (error instanceof CodexExecutionError) return error;
  if (error instanceof CodexFactoryError)
    return new CodexExecutionError(error.code, error.question);
  return new CodexExecutionError("unavailable");
}
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason instanceof CodexExecutionError
      ? signal.reason
      : new CodexExecutionError("cancelled");
}

async function withCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) void operation.catch(() => undefined);
  checkAbort(signal);
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      try {
        checkAbort(signal);
      } catch (error) {
        reject(executionError(error));
      }
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
function timeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 7_200_000)
    throw new CodexExecutionError("invalid_response");
  return value;
}
function textPrefix(value: unknown, bytes = 2_048): string {
  if (typeof value !== "string") throw new CodexExecutionError("invalid_response");
  return Buffer.from(value).subarray(0, bytes).toString("utf8");
}
async function existingPath(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0") || path.includes(","))
    throw new CodexExecutionError("invalid_response");
  const canonical = await realpath(path).catch(() => {
    throw new CodexExecutionError("sandbox_unavailable", undefined, "workspace_unavailable");
  });
  if (canonical.includes(",")) throw new CodexExecutionError("invalid_response");
  return canonical;
}

async function processOutput(
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
  env = safeEnvironment(),
): Promise<Omit<CodexVerificationResult, "processId" | "durationMs">> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stdoutTruncated: false,
      stderrTruncated: false,
    };
    let failed = false;
    const abort = () => {
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", abort, { once: true });
    for (const stream of ["stdout", "stderr"] as const)
      child[stream].on("data", (chunk: Buffer) => {
        const available = OUTPUT_CAP - output[stream].length;
        if (chunk.length > available) output[`${stream}Truncated`] = true;
        if (available > 0)
          output[stream] = Buffer.concat([output[stream], chunk.subarray(0, available)]);
      });
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (exitCode) => {
      signal.removeEventListener("abort", abort);
      try {
        checkAbort(signal);
      } catch (error) {
        reject(executionError(error));
        return;
      }
      if (failed || exitCode === null) {
        reject(new CodexExecutionError("sandbox_unavailable", undefined, "docker_unavailable"));
        return;
      }
      resolve({
        exitCode,
        stdout: output.stdout.toString("utf8"),
        stderr: output.stderr.toString("utf8"),
        stdoutTruncated: output.stdoutTruncated,
        stderrTruncated: output.stderrTruncated,
      });
    });
    if (signal.aborted) abort();
  });
}

function daemonIdentity(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u.test(value))
    throw new CodexExecutionError("sandbox_unavailable", undefined, "daemon_identity_unavailable");
  return value;
}

/** Teardown only: recovery cannot create a container or reconnect to an executor. */
export function createCodexExecutionContainerRecovery(
  options: { dockerExecutable?: string } = {},
): (
  container: { name: string; id: string | null; daemonId?: string | null },
  onIdentified: (id: string) => Promise<void>,
  signal: AbortSignal,
) => Promise<{ name: string; id: string }> {
  return async (container, onIdentified, signal) => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const cli = async (args: readonly string[]) => {
      const result = await processOutput(options.dockerExecutable ?? "docker", args, deadline);
      if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated)
        throw new Error("Docker operation was not confirmed");
      return result.stdout.trim();
    };
    const find = async (filter: string): Promise<string | null> => {
      const found = await cli([
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        filter,
        "--format",
        "{{.ID}}",
      ]);
      if (found === "") return null;
      if (!/^[a-f0-9]{64}$/u.test(found)) throw new Error("Container lookup was ambiguous");
      return found;
    };
    try {
      if (
        !/^kestrel-factory-[a-f0-9-]{32,64}$/u.test(container.name) ||
        (container.id !== null && !/^[a-f0-9]{64}$/u.test(container.id))
      )
        throw new Error("Invalid persisted container identity");
      const daemonId = daemonIdentity(await cli(["info", "--format", "{{.ID}}"]));
      if (container.daemonId != null && daemonIdentity(container.daemonId) !== daemonId)
        throw new Error("Docker daemon identity changed");
      const assertDaemon = async () => {
        if (daemonIdentity(await cli(["info", "--format", "{{.ID}}"])) !== daemonId)
          throw new Error("Docker daemon identity changed");
      };
      const byName = await find(`name=^/${container.name}$`);
      const id = container.id ?? byName;
      // A suspended owner can still complete a create that was reserved before fencing.
      // Absence without a persisted/discovered ID is not evidence of teardown.
      if (id === null || (byName !== null && byName !== id))
        throw new Error("Container identity was not confirmed");
      const byId = await find(`id=${id}`);
      if (byId !== null && byId !== id) throw new Error("Container identity changed");
      if (byId !== null) {
        const state = record(JSON.parse(await cli(["inspect", "--format", CONTAINER_INSPECT, id])));
        if (
          state.id !== id ||
          state.name !== `/${container.name}` ||
          record(state.labels)["kestrel.factory.execution"] !== container.name
        )
          throw new Error("Container ownership changed");
      } else if (container.id === null || byName !== null || container.daemonId == null) {
        throw new Error("Discovered container disappeared before ownership was verified");
      }
      // Commit this witness before the irreversible removal. A restarted reconciler can
      // then prove this same ID absent if the process dies before recording stopped_at.
      await withCancellation(onIdentified(id), deadline);
      await assertDaemon();
      if (byId !== null) await cli(["rm", "--force", id]);
      if ((await find(`name=^/${container.name}$`)) !== null || (await find(`id=${id}`)) !== null)
        throw new Error("Container teardown was not confirmed");
      await assertDaemon();
      return { name: container.name, id };
    } catch {
      throw new CodexExecutionError("stop_unconfirmed");
    }
  };
}

class ExecutionContainer {
  readonly name: string;
  readonly #docker: string;
  readonly #options: Options;
  readonly #lifecycle: CodexExecutionLifecycle;
  readonly #workspace: string;
  readonly #control: string;
  readonly #gitDirectory: string | undefined;
  #id: string | null = null;
  #daemonId: string | null = null;
  #reserved = false;
  #mounts: { source: string; target: string; readonly: boolean }[] = [];

  constructor(
    options: Options,
    input: CodexExecutionLifecycle,
    workspace: string,
    control: string,
    requestId: string,
    gitDirectory?: string,
  ) {
    this.#options = options;
    this.#docker = options.dockerExecutable ?? "docker";
    this.#lifecycle = input;
    this.#workspace = workspace;
    this.#control = control;
    this.#gitDirectory = gitDirectory;
    this.name = `kestrel-factory-${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`;
  }
  get id(): string {
    if (this.#id === null) throw new CodexExecutionError("invalid_response");
    return this.#id;
  }
  async cli(args: readonly string[], signal?: AbortSignal): Promise<string> {
    const deadline = AbortSignal.timeout(10_000);
    const result = await processOutput(
      this.#docker,
      args,
      signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
    );
    if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated)
      throw new CodexExecutionError("sandbox_unavailable", undefined, "docker_operation_failed");
    return result.stdout.trim();
  }
  async inspect(): Promise<Record<string, unknown>> {
    return record(JSON.parse(await this.cli(["inspect", "--format", CONTAINER_INSPECT, this.id])));
  }
  async assertDaemon(signal?: AbortSignal): Promise<void> {
    if (
      this.#daemonId === null ||
      daemonIdentity(await this.cli(["info", "--format", "{{.ID}}"], signal)) !== this.#daemonId
    )
      throw new CodexExecutionError("sandbox_unavailable", undefined, "daemon_identity_changed");
  }
  async create(command: readonly string[], commandCwd: string, signal: AbortSignal): Promise<void> {
    const program = command[0];
    if (program === undefined) throw new CodexExecutionError("invalid_response");
    if (!/^sha256:[a-f0-9]{64}$/u.test(this.#options.containerImage))
      throw new CodexExecutionError("sandbox_unavailable", undefined, "immutable_image_required");
    const image = await this.cli(
      ["image", "inspect", "--format", "{{.Id}}", this.#options.containerImage],
      signal,
    ).catch(() => {
      throw new CodexExecutionError("sandbox_unavailable", undefined, "image_unavailable");
    });
    if (image !== this.#options.containerImage)
      throw new CodexExecutionError("sandbox_unavailable", undefined, "image_changed");
    const gitMarker = join(this.#workspace, ".git");
    const markerInfo = await lstat(gitMarker).catch(() => null);
    if (markerInfo === null || !markerInfo.isFile())
      throw new CodexExecutionError(
        "sandbox_unavailable",
        undefined,
        "workspace_metadata_unavailable",
      );
    const protectedMarker = join(this.#control, "git-marker");
    await writeFile(protectedMarker, "gitdir: /kestrel-git\n", { mode: 0o400 });
    this.#mounts = [
      { source: this.#workspace, target: "/workspace", readonly: false },
      { source: protectedMarker, target: "/workspace/.git", readonly: true },
    ];
    if (this.#gitDirectory !== undefined)
      this.#mounts.push({
        source: await existingPath(this.#gitDirectory),
        target: "/kestrel-git",
        readonly: true,
      });
    for (const name of [".kestrel", ".agents", ".codex"]) {
      const source = join(this.#workspace, name);
      const info = await lstat(source).catch(() => null);
      if (info === null) continue;
      if (!info.isFile() && !info.isDirectory())
        throw new CodexExecutionError("permission_required");
      this.#mounts.push({ source, target: `/workspace/${name}`, readonly: true });
    }
    this.#daemonId = daemonIdentity(await this.cli(["info", "--format", "{{.ID}}"], signal));
    this.#reserved = true;
    await withCancellation(
      this.#lifecycle.beforeContainerCreate(this.name, this.#daemonId),
      signal,
    );
    checkAbort(signal);
    await this.assertDaemon(signal);
    const id = await this.cli(
      [
        "create",
        "--pull=never",
        "--name",
        this.name,
        "--label",
        `kestrel.factory.execution=${this.name}`,
        "--read-only",
        "--network",
        "none",
        "--restart",
        "no",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        "128",
        "--memory",
        "1g",
        "--cpus",
        "2",
        "--user",
        `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`,
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=67108864,mode=1777",
        "--tmpfs",
        "/home/codex:rw,nosuid,nodev,size=67108864,mode=1777",
        ...this.#mounts.flatMap((mount) => [
          "--mount",
          `type=bind,source=${mount.source},target=${mount.target}${mount.readonly ? ",readonly" : ""}`,
        ]),
        "--workdir",
        commandCwd,
        "--env",
        "HOME=/home/codex",
        "--env",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "--entrypoint",
        program,
        image,
        ...command.slice(1),
      ],
      signal,
    );
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new CodexExecutionError("invalid_response");
    this.#id = id;
    await this.assertDaemon(signal);
    await withCancellation(this.#lifecycle.onContainer({ name: this.name, id }), signal);
    const state = await this.inspect();
    const actualMounts = state.mounts;
    if (
      state.id !== id ||
      state.name !== `/${this.name}` ||
      state.image !== image ||
      state.running !== false ||
      state.network !== "none" ||
      state.readonly !== true ||
      state.privileged !== false ||
      state.pidMode !== "" ||
      state.restart !== "no" ||
      !Array.isArray(state.capDrop) ||
      !state.capDrop.includes("ALL") ||
      !Array.isArray(state.securityOpt) ||
      !state.securityOpt.includes("no-new-privileges:true") ||
      record(state.labels)["kestrel.factory.execution"] !== this.name ||
      !Array.isArray(actualMounts) ||
      actualMounts.length !== this.#mounts.length ||
      this.#mounts.some(
        (mount) =>
          !actualMounts.some(
            (value) =>
              isRecord(value) &&
              value.Type === "bind" &&
              value.Source === mount.source &&
              value.Destination === mount.target &&
              value.RW === !mount.readonly,
          ),
      )
    )
      throw new CodexExecutionError("permission_required");
    checkAbort(signal);
  }
  async startExecutor(signal: AbortSignal): Promise<void> {
    await this.assertDaemon(signal);
    await this.cli(["start", this.id], signal);
    await this.cli(["exec", this.id, "node", "-e", READY], signal).catch(() => {
      throw new CodexExecutionError("sandbox_unavailable", undefined, "executor_unavailable");
    });
  }
  async verify(
    signal: AbortSignal,
  ): Promise<Omit<CodexVerificationResult, "processId" | "durationMs">> {
    await this.assertDaemon(signal);
    const output = await processOutput(this.#docker, ["start", "--attach", this.id], signal);
    await this.assertDaemon(signal);
    const state = await this.inspect();
    if (state.status !== "exited")
      throw new CodexExecutionError("sandbox_unavailable", undefined, "verification_not_started");
    if (
      state.running !== false ||
      !Number.isSafeInteger(state.exitCode) ||
      state.exitCode !== output.exitCode
    )
      throw new CodexExecutionError("invalid_response");
    return { ...output, exitCode: state.exitCode };
  }
  async forward(signal: AbortSignal): Promise<{ url: string; close(): Promise<void> }> {
    const sockets = new Set<Socket>();
    const children = new Set<ReturnType<typeof spawn>>();
    const server = createServer((socket) => {
      if (sockets.size >= 4 || signal.aborted) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      const child = spawn(this.#docker, ["exec", "-i", this.id, "node", "-e", FORWARD], {
        env: safeEnvironment(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      socket.pipe(child.stdin);
      child.stdout.pipe(socket);
      child.stderr.resume();
      child.once("error", () => socket.destroy());
      child.once("close", () => {
        children.delete(child);
        socket.destroy();
      });
      child.stdin.on("error", () => socket.destroy());
      socket.on("error", () => child.kill("SIGKILL"));
      socket.on("close", () => {
        sockets.delete(socket);
        child.stdin.end();
        child.kill("SIGKILL");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new CodexExecutionError("sandbox_unavailable");
    return {
      url: `ws://127.0.0.1:${String(address.port)}`,
      close: () => closeForwarder(server, sockets, children),
    };
  }
  async stop(): Promise<void> {
    if (!this.#reserved) return;
    try {
      await this.assertDaemon();
      if (this.#id === null) {
        const id = await this.cli([
          "container",
          "ls",
          "--all",
          "--no-trunc",
          "--filter",
          `name=^/${this.name}$`,
          "--format",
          "{{.ID}}",
        ]);
        if (id !== "") {
          if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("Ambiguous container");
          this.#id = id;
        }
      }
      if (this.#id !== null) {
        const state = await this.inspect();
        if (
          state.id !== this.#id ||
          state.name !== `/${this.name}` ||
          record(state.labels)["kestrel.factory.execution"] !== this.name
        )
          throw new Error("Container identity changed");
        // Removing the exact private PID namespace is the writer-lifetime boundary.
        // Stopping only Codex, its socket, or a docker-exec client is insufficient.
        await this.assertDaemon();
        await this.cli(["rm", "--force", this.#id]);
      }
      const remaining = await this.cli([
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `name=^/${this.name}$`,
        "--format",
        "{{.ID}}",
      ]);
      if (remaining !== "") throw new Error("Container still present");
      await this.assertDaemon();
      await withCancellation(
        this.#lifecycle.onStopped({ name: this.name, id: this.#id }),
        AbortSignal.timeout(10_000),
      );
    } catch {
      throw new CodexExecutionError("stop_unconfirmed");
    }
  }
}

async function closeForwarder(
  server: Server,
  sockets: Set<Socket>,
  children: Set<ReturnType<typeof spawn>>,
): Promise<void> {
  for (const socket of sockets) socket.destroy();
  for (const child of children) child.kill("SIGKILL");
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

class ExecutionTurn {
  readonly transport: CodexFactoryTransport;
  readonly #input: CodexExecutionTurnInput;
  #threadId: string | undefined;
  #turnId: string | undefined;
  #completed = false;
  #text: string | undefined;
  #legacyText: string | undefined;
  #queue: Promise<void> = Promise.resolve();
  #queued = 0;
  #events = 0;
  readonly #seen = new Set<string>();
  #resolve!: (result: CodexExecutionTurnResult) => void;
  readonly #result = new Promise<CodexExecutionTurnResult>((resolve) => {
    this.#resolve = resolve;
  });

  constructor(
    options: Options,
    input: CodexExecutionTurnInput,
    hostCwd: string,
    url: string,
    signal: AbortSignal,
    timeoutMs: number,
  ) {
    this.#input = input;
    this.transport = new CodexFactoryTransport({
      executable: options.executable ?? "codex",
      arguments: [
        ...(options.arguments ?? ["app-server", "--listen", "stdio://"]),
        ...SAFETY_ARGUMENTS,
      ],
      cwd: hostCwd,
      env: { ...safeEnvironment(), CODEX_EXEC_SERVER_URL: url },
      timeoutMs,
      signal,
      receive: (message) => this.#receive(message),
    });
  }
  #enqueue(operation: () => Promise<void>): void {
    if (++this.#queued > 128 || ++this.#events > 2_048)
      throw new CodexExecutionError("invalid_response");
    this.#queue = this.#queue.then(operation).then(() => {
      this.#queued--;
    });
    void this.#queue.catch((error: unknown) => this.transport.fail(executionError(error)));
  }
  #observe(threadId: unknown, turnId: unknown): string {
    const id = boundedString(turnId);
    if (threadId !== this.#threadId || (this.#turnId !== undefined && this.#turnId !== id))
      throw new CodexExecutionError("invalid_response");
    if (this.#turnId === undefined) {
      this.#turnId = id;
      this.transport.started();
      this.#enqueue(() => this.#input.onTurn(id));
    }
    return id;
  }
  #question(code: CodexExecutionQuestion["code"], question: string): void {
    this.#enqueue(async () => {
      await this.#input.onQuestion({ code, question });
      throw new CodexExecutionError(code, question);
    });
  }
  #receive(message: Record<string, unknown>): void {
    const method = boundedString(message.method);
    if ("id" in message) {
      if (typeof message.id !== "string" && typeof message.id !== "number")
        throw new CodexExecutionError("invalid_response");
      const params = record(message.params);
      if (params.threadId !== undefined) this.#observe(params.threadId, params.turnId);
      if (method === "item/tool/requestUserInput") {
        const question = inputQuestion(params);
        this.transport.send({ id: message.id, result: { answers: {} } });
        this.#question("input_required", question);
      } else if (
        method === "item/commandExecution/requestApproval" ||
        method === "item/fileChange/requestApproval"
      ) {
        this.transport.send({ id: message.id, result: { decision: "cancel" } });
        this.#question(
          "permission_required",
          "The execution requested authority outside its isolated workspace. Review the approved scope before continuing.",
        );
      } else if (method === "item/permissions/requestApproval") {
        this.transport.send({ id: message.id, result: { permissions: {}, scope: "turn" } });
        this.#question(
          "permission_required",
          "The execution requested additional permissions. Review the approved scope before continuing.",
        );
      } else if (method === "mcpServer/elicitation/request") {
        this.transport.send({ id: message.id, result: { action: "cancel" } });
        this.#question(
          "permission_required",
          "External tools are unavailable in the approved execution environment.",
        );
      } else {
        this.transport.send({
          id: message.id,
          error: { code: -32601, message: "Unsupported request" },
        });
        throw new CodexExecutionError("invalid_response");
      }
      return;
    }
    if (
      !["turn/started", "turn/completed", "item/started", "item/completed", "error"].includes(
        method,
      )
    )
      return;
    const params = record(message.params);
    if (method === "turn/started" || method === "turn/completed") {
      const turn = record(params.turn);
      const turnId = this.#observe(params.threadId, turn.id);
      if (method === "turn/started") return;
      if (turn.status === "interrupted") throw new CodexExecutionError("interrupted");
      if (turn.status === "failed") throw protocolError(turn.error);
      if (turn.status !== "completed" || turn.error != null)
        throw new CodexExecutionError("invalid_response");
      if (Array.isArray(turn.items)) for (const item of turn.items) this.#item(item, true);
      const text = this.#text ?? this.#legacyText;
      if (text === undefined || this.#threadId === undefined)
        throw new CodexExecutionError("invalid_response");
      const threadId = this.#threadId;
      this.#enqueue(async () => {
        this.#completed = true;
        this.transport.completed();
        this.#resolve({ threadId, turnId, text });
        await Promise.resolve();
      });
      return;
    }
    this.#observe(params.threadId, params.turnId);
    if (method === "error") {
      const error = protocolError(params.error);
      if (params.willRetry !== true || error.code !== "unavailable") throw error;
    } else this.#item(params.item, method === "item/completed");
  }
  #item(value: unknown, completed: boolean): void {
    const item = record(value);
    const type = boundedString(item.type);
    const id = boundedString(item.id);
    if (["reasoning", "plan", "userMessage", "contextCompaction"].includes(type)) return;
    if (!["agentMessage", "commandExecution", "fileChange"].includes(type))
      throw new CodexExecutionError("permission_required");
    if (type === "agentMessage" && completed) {
      const text = boundedString(item.text, 128 * 1024);
      if (item.phase === "final_answer") this.#text = text;
      else if (item.phase == null) this.#legacyText = text;
      else if (item.phase !== "commentary") throw new CodexExecutionError("invalid_response");
    }
    const key = `${completed ? "completed" : "started"}:${id}`;
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    const activity: CodexExecutionActivity = {
      itemId: id,
      kind:
        type === "agentMessage"
          ? "message"
          : type === "commandExecution"
            ? "command"
            : "file_change",
      state: completed ? "completed" : "started",
      summary:
        type === "agentMessage"
          ? textPrefix(item.text ?? "")
          : type === "commandExecution"
            ? textPrefix(item.command ?? "Command execution")
            : "Workspace file changes",
    };
    this.#enqueue(() => this.#input.onActivity(activity));
  }
  async run(hostCwd: string): Promise<CodexExecutionTurnResult> {
    const initialized = await this.transport.request("initialize", {
      clientInfo: { name: "kestrel", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    boundedString(initialized.userAgent, 512);
    this.transport.notify("initialized");
    const local = await this.transport.request("environment/status", { environmentId: "local" });
    if (local.status !== "unknown") throw new CodexExecutionError("permission_required");
    const remote = await this.transport.request("environment/info", { environmentId: "remote" });
    if (remote.cwd !== "file:///workspace") throw new CodexExecutionError("permission_required");
    const response = await this.transport.request("config/read", {
      cwd: hostCwd,
      includeLayers: false,
    });
    const config = record(response.config);
    const features = record(config.features);
    if (
      Object.entries(FEATURES).some(([name, value]) => features[name] !== value) ||
      config.web_search !== "disabled" ||
      config.allow_login_shell !== false
    )
      throw new CodexExecutionError("permission_required");
    const names = Object.keys(config.mcp_servers === undefined ? {} : record(config.mcp_servers));
    if (names.length > 256) throw new CodexExecutionError("invalid_response");
    const mcpServers = Object.fromEntries(
      names.map((name) => [boundedString(name), { enabled: false }]),
    );
    const thread = await this.transport.request("thread/start", {
      cwd: hostCwd,
      model: this.#input.model,
      modelProvider: "openai",
      sandbox: "read-only",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      environments: ENVIRONMENTS,
      config: {
        features: FEATURES,
        model_provider: "openai",
        web_search: "disabled",
        allow_login_shell: false,
        mcp_servers: mcpServers,
        shell_environment_policy: {
          inherit: "none",
          set: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/codex", TMPDIR: "/tmp" },
        },
      },
      developerInstructions:
        "Implement only the approved scope in the selected remote workspace. That environment is contained externally. Do not access host tools, external services, privileges, or Git metadata writes. Ask when requirements or authorization must change.",
    });
    const sandbox = record(thread.sandbox);
    if (
      thread.cwd !== hostCwd ||
      thread.model !== this.#input.model ||
      thread.modelProvider !== "openai" ||
      thread.approvalPolicy !== "never" ||
      thread.approvalsReviewer !== "user" ||
      sandbox.type !== "readOnly" ||
      (sandbox.networkAccess ?? false) !== false ||
      Object.keys(sandbox).some((key) => !["type", "networkAccess"].includes(key)) ||
      JSON.stringify(thread.runtimeWorkspaceRoots) !== JSON.stringify(["/workspace"])
    )
      throw new CodexExecutionError("permission_required");
    this.#threadId = boundedString(record(thread.thread).id);
    await this.transport.guard(this.#input.onThread(this.#threadId));
    const turn = await this.transport.request("turn/start", {
      threadId: this.#threadId,
      model: this.#input.model,
      clientUserMessageId: this.#input.requestId,
      input: [{ type: "text", text: this.#input.prompt }],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" },
      environments: ENVIRONMENTS,
      ...(this.#input.outputSchema === undefined ? {} : { outputSchema: this.#input.outputSchema }),
    });
    this.#observe(this.#threadId, record(turn.turn).id);
    return this.transport.guard(this.#result);
  }
  async close(): Promise<void> {
    await this.transport.close(
      this.#threadId !== undefined && this.#turnId !== undefined && !this.#completed
        ? { method: "turn/interrupt", params: { threadId: this.#threadId, turnId: this.#turnId } }
        : undefined,
    );
  }
}

async function isolated<T>(
  options: Options,
  input: CodexExecutionLifecycle & { signal?: AbortSignal; gitDirectory?: string },
  workspacePath: string,
  requestId: string,
  timeoutMs: number,
  operation: (container: ExecutionContainer, control: string, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  boundedString(requestId);
  timeout(timeoutMs);
  if (input.signal?.aborted) throw new CodexExecutionError("cancelled");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new CodexExecutionError("timeout")), timeoutMs);
  const signal =
    input.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, input.signal]);
  let control: string | undefined;
  let container: ExecutionContainer | undefined;
  try {
    const workspace = await existingPath(workspacePath);
    if (!(await lstat(workspace)).isDirectory()) throw new CodexExecutionError("invalid_response");
    control = await realpath(await mkdtemp(join(tmpdir(), "kestrel-execution-control-")));
    container = new ExecutionContainer(
      options,
      input,
      workspace,
      control,
      requestId,
      input.gitDirectory,
    );
    return await operation(container, control, signal);
  } catch (error) {
    checkAbort(signal);
    throw executionError(error);
  } finally {
    clearTimeout(timer);
    await container?.stop();
    if (control !== undefined) await rm(control, { recursive: true, force: true });
  }
}

export function createCodexExecutionRuntime(options: Options): CodexExecutionRuntime {
  return {
    async runTurn(input) {
      try {
        boundedString(input.model, 128);
        boundedString(input.prompt, 256 * 1024);
        if (
          input.outputSchema !== undefined &&
          Buffer.byteLength(JSON.stringify(input.outputSchema)) > 64 * 1024
        )
          throw new CodexExecutionError("invalid_response");
        const limit = timeout(options.timeoutMs ?? 120_000);
        return await isolated(
          options,
          input,
          input.cwd,
          input.requestId,
          limit,
          async (container, control, signal) => {
            await container.create(
              [
                "/usr/local/bin/codex",
                "exec-server",
                "--listen",
                "ws://127.0.0.1:8765",
                "--concurrent-requests",
                "16",
              ],
              "/workspace",
              signal,
            );
            await container.startExecutor(signal);
            const forwarder = await container.forward(signal);
            const turn = new ExecutionTurn(options, input, control, forwarder.url, signal, limit);
            try {
              return await turn.run(control);
            } finally {
              try {
                await turn.close();
              } finally {
                await forwarder.close();
              }
            }
          },
        );
      } catch (error) {
        throw executionError(error);
      }
    },
    async runVerification(input) {
      try {
        if (
          input.command.length < 1 ||
          input.command.length > 128 ||
          input.command.some((part) => typeof part !== "string" || part.includes("\0")) ||
          Buffer.byteLength(JSON.stringify(input.command)) > 32 * 1024 ||
          !input.command[0]?.trim() ||
          isAbsolute(input.cwd) ||
          input.cwd.includes("\0")
        )
          throw new CodexExecutionError("invalid_response");
        const workspace = await existingPath(input.workspaceCwd);
        const commandCwd = await existingPath(join(workspace, input.cwd));
        const path = relative(workspace, commandCwd);
        if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
          throw new CodexExecutionError("permission_required");
        return await isolated(
          options,
          input,
          workspace,
          input.processId,
          input.timeoutMs,
          async (container, _control, signal) => {
            await container.create(
              input.command,
              path === "" ? "/workspace" : `/workspace/${path.split(sep).join("/")}`,
              signal,
            );
            const started = performance.now();
            const result = await container.verify(signal);
            return {
              ...result,
              processId: input.processId,
              durationMs: Math.round(performance.now() - started),
            };
          },
        );
      } catch (error) {
        throw executionError(error);
      }
    },
  };
}
