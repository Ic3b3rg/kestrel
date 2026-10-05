import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  FactoryPrivateDockerStorageSchema,
  type FactoryPrivateDockerStorage,
} from "@kestrel/contracts";
import { privateDockerStorageFor, removePrivateDockerStorage } from "./private-docker-storage.js";

import {
  CodexFactoryError,
  CodexAppServerTransport,
  boundedString,
  inputQuestion,
  isRecord,
  protocolError,
  record,
  safeEnvironment,
  type CodexFactoryErrorCode,
} from "./codex-app-server-transport.js";

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
  kind: "message" | "reasoning" | "command" | "file_change" | "subagent";
  state: "started" | "completed" | "failed";
  summary: string;
  agentPath?: string;
  detail?: string;
  exitCode?: number;
}
export interface CodexExecutionQuestion {
  code: "input_required" | "permission_required";
  question: string;
}
export interface CodexExecutionLifecycle {
  beforeContainerCreate(
    name: string,
    daemonId?: string,
    privateStorageRequired?: true,
  ): Promise<void>;
  onContainer(container: {
    name: string;
    id: string;
    privateStorage?: FactoryPrivateDockerStorage;
  }): Promise<void>;
  onStopped(container: { name: string; id: string | null }): Promise<void>;
}
export interface CodexExecutionTurnInput extends CodexExecutionLifecycle {
  cwd: string;
  gitDirectory?: string;
  model: string;
  effort?: string | null;
  serviceTier?: string | null;
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
  effectiveProfile?: { model: string; effort: string | null; serviceTier: string | null };
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
  timedOut?: boolean;
}
export interface CodexExecutionRuntime {
  runTurn(input: CodexExecutionTurnInput): Promise<CodexExecutionTurnResult>;
  runVerification(input: CodexVerificationInput): Promise<CodexVerificationResult>;
}
export interface CodexExecutionRuntimeOptions {
  /** Installation-authorized trusted Project only; never inferred from repository content. */
  projectEnvironment?: "node_docker";
  executable?: string;
  arguments?: readonly string[];
  timeoutMs?: number | null;
  dockerExecutable?: string;
  containerImage: string;
  workspaceReadonly?: boolean;
  allowFileChanges?: boolean;
  developerInstructions?: string;
  controlDirectory?: string;
  containerUser?: string;
  expectedExecutableDigest?: string;
  expectedCodexVersion?: string;
  authenticationFile?: string;
  isolateHostProfile?: boolean;
  containerResources?: {
    pidsLimit: number;
    memoryBytes: number;
    nanoCpus: number;
    tmpfsBytes: number;
  };
}
export const DEFAULT_CODEX_CONTAINER_RESOURCES = {
  pidsLimit: 128,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  nanoCpus: 2_000_000_000,
  tmpfsBytes: 64 * 1024 * 1024,
} as const;
const DISABLED = [
  "apps",
  "plugins",
  "hooks",
  "browser_use",
  "browser_use_external",
  "in_app_browser",
  "code_mode",
  "code_mode_only",
  "shell_snapshot",
  "shell_snapshot_v2",
  "auth_elicitation",
  "mentions_v2",
  "remote_plugin",
  "tool_suggest",
];
const FEATURES = {
  ...Object.fromEntries(DISABLED.map((name) => [name, false])),
  multi_agent: true,
  multi_agent_v2: true,
  shell_tool: true,
  skip_host_skill_discovery: true,
};
const MAX_SUBAGENT_THREADS = 3;
const TURN_FEATURES = {
  ...FEATURES,
  multi_agent_v2: {
    enabled: true,
    max_concurrent_threads_per_session: MAX_SUBAGENT_THREADS,
  },
};
const SAFETY_ARGUMENTS = [
  "--strict-config",
  ...DISABLED.flatMap((name) => ["--disable", name]),
  "--enable",
  "shell_tool",
  "--enable",
  "skip_host_skill_discovery",
  "--enable",
  "multi_agent",
  "--enable",
  "multi_agent_v2",
  "-c",
  `features.multi_agent_v2.max_concurrent_threads_per_session=${String(MAX_SUBAGENT_THREADS)}`,
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
  "-c",
  "notify=[]",
];
const ISOLATED_PROFILE_ARGUMENTS = ["-c", "project_doc_max_bytes=0"];
const ISOLATED_PROFILE_CONFIG = "project_doc_max_bytes = 0\n";
const ENVIRONMENTS = [
  { environmentId: "remote", cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
];
const OUTPUT_CAP = 64 * 1024;
const CONTAINER_INSPECT =
  '{"id":{{json .Id}},"name":{{json .Name}},"running":{{.State.Running}},"status":{{json .State.Status}},"exitCode":{{.State.ExitCode}},"image":{{json .Image}},"user":{{json .Config.User}},"network":{{json .HostConfig.NetworkMode}},"logDriver":{{json .HostConfig.LogConfig.Type}},"readonly":{{.HostConfig.ReadonlyRootfs}},"privileged":{{.HostConfig.Privileged}},"pidMode":{{json .HostConfig.PidMode}},"cgroupns":{{json .HostConfig.CgroupnsMode}},"restart":{{json .HostConfig.RestartPolicy.Name}},"init":{{.HostConfig.Init}},"pidsLimit":{{.HostConfig.PidsLimit}},"memory":{{.HostConfig.Memory}},"memorySwap":{{.HostConfig.MemorySwap}},"nanoCpus":{{.HostConfig.NanoCpus}},"cpusetCpus":{{json .HostConfig.CpusetCpus}},"shmSize":{{.HostConfig.ShmSize}},"tmpfs":{{json .HostConfig.Tmpfs}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"mounts":{{json .Mounts}},"labels":{{json .Config.Labels}}}';
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
  try {
    const value = await operation;
    checkAbort(signal);
    return value;
  } catch (error) {
    if (signal.aborted) checkAbort(signal);
    throw error;
  }
}
function timeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 7_200_000)
    throw new CodexExecutionError("invalid_response");
  return value;
}
async function verifyHostCodex(options: CodexExecutionRuntimeOptions): Promise<void> {
  if (options.expectedExecutableDigest === undefined && options.expectedCodexVersion === undefined)
    return;
  if (
    options.executable === undefined ||
    !isAbsolute(options.executable) ||
    !/^[a-f0-9]{64}$/u.test(options.expectedExecutableDigest ?? "") ||
    !/^\d+\.\d+\.[0-9A-Za-z.+-]+$/u.test(options.expectedCodexVersion ?? "")
  )
    throw new CodexExecutionError("sandbox_unavailable", undefined, "runtime_profile_mismatch");
  const canonical = await realpath(options.executable).catch(() => null);
  if (canonical !== options.executable)
    throw new CodexExecutionError("sandbox_unavailable", undefined, "runtime_profile_mismatch");
  const digest = await readFile(canonical)
    .then((bytes) => createHash("sha256").update(bytes).digest("hex"))
    .catch(() => null);
  if (digest !== options.expectedExecutableDigest)
    throw new CodexExecutionError("sandbox_unavailable", undefined, "runtime_profile_mismatch");
}

function codexVersion(userAgent: unknown): string {
  const value = boundedString(userAgent, 512);
  const match = /^(?:kestrel|codex)\/(\d+\.\d+\.[0-9A-Za-z.+-]+)(?:\s|$)/u.exec(value);
  if (match?.[1] === undefined) throw new CodexExecutionError("permission_required");
  return match[1];
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

interface IsolatedCodexProfile {
  codexHome: string;
  environment: NodeJS.ProcessEnv;
}

async function prepareIsolatedCodexProfile(
  controlDirectory: string,
  authenticationFile?: string,
): Promise<IsolatedCodexProfile> {
  const source = await realpath(
    authenticationFile ??
      join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json"),
  ).catch(() => {
    throw new CodexExecutionError("authentication");
  });
  const sourceInfo = await stat(source).catch(() => null);
  if (
    sourceInfo === null ||
    !sourceInfo.isFile() ||
    sourceInfo.size < 1 ||
    sourceInfo.size > 1024 * 1024 ||
    (process.getuid !== undefined && sourceInfo.uid !== process.getuid()) ||
    (process.platform !== "win32" && (sourceInfo.mode & 0o077) !== 0)
  )
    throw new CodexExecutionError("authentication");

  const root = join(controlDirectory, "host-profile");
  const codexHome = join(root, "codex");
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  await Promise.all([
    mkdir(codexHome, { recursive: true, mode: 0o700 }),
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(xdg, { recursive: true, mode: 0o700 }),
  ]);
  const isolatedAuthentication = join(codexHome, "auth.json");
  await copyFile(source, isolatedAuthentication);
  await chmod(isolatedAuthentication, 0o600);
  await writeFile(join(codexHome, "config.toml"), ISOLATED_PROFILE_CONFIG, {
    mode: 0o600,
    flag: "wx",
  });
  return {
    codexHome,
    environment: {
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: xdg,
    },
  };
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

function nameBarrierArguments(name: string, image: string): string[] {
  if (!/^sha256:[a-f0-9]{64}$/u.test(image)) throw new Error("Invalid recovery image identity");
  return [
    "create",
    "--pull=never",
    "--name",
    name,
    "--label",
    `kestrel.factory.execution=${name}`,
    "--read-only",
    "--network",
    "none",
    "--log-driver",
    "none",
    "--restart",
    "no",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    "1",
    "--memory",
    String(64 * 1024 * 1024),
    "--memory-swap",
    String(64 * 1024 * 1024),
    "--shm-size",
    String(64 * 1024),
    "--cpus",
    "0.001",
    "--user",
    "65534:65534",
    "--entrypoint",
    "/bin/true",
    image,
  ];
}

/** Teardown only: recovery may claim an absent reserved name with an inert, never-started barrier. */
export function createCodexExecutionContainerRecovery(
  options: { dockerExecutable?: string } = {},
): (
  container: {
    name: string;
    id: string | null;
    daemonId?: string | null;
    image?: string | null;
    privateStorage?: FactoryPrivateDockerStorage | null;
    privateStorageRequired?: true;
  },
  onIdentified: (id: string, privateStorage?: FactoryPrivateDockerStorage) => Promise<void>,
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
      let byName = await find(`name=^/${container.name}$`);
      let id = container.id ?? byName;
      if (byName === null && container.privateStorageRequired && container.privateStorage == null)
        throw new Error("Required private storage was never identified");
      if (id === null && container.image != null) {
        const barrier = await cli(nameBarrierArguments(container.name, container.image)).catch(
          () => "",
        );
        if (/^[a-f0-9]{64}$/u.test(barrier)) id = barrier;
        else {
          byName = await find(`name=^/${container.name}$`);
          id = byName;
        }
      }
      // Claiming the unique Docker name is a barrier: any delayed create from the
      // fenced owner must fail before this inert container is removed.
      if (id === null || (byName !== null && byName !== id))
        throw new Error("Container identity was not confirmed");
      const byId = await find(`id=${id}`);
      if (byId !== null && byId !== id) throw new Error("Container identity changed");
      let privateStorage =
        container.privateStorage == null
          ? null
          : FactoryPrivateDockerStorageSchema.parse(container.privateStorage);
      if (byId !== null) {
        const state = record(JSON.parse(await cli(["inspect", "--format", CONTAINER_INSPECT, id])));
        if (
          state.id !== id ||
          state.name !== `/${container.name}` ||
          (container.image != null && state.image !== container.image) ||
          record(state.labels)["kestrel.factory.execution"] !== container.name
        )
          throw new Error("Container ownership changed");
        if (record(state.labels)["kestrel.factory.private-docker-storage"] === "anonymous") {
          const actual = await privateDockerStorageFor(cli, state.mounts);
          if (
            privateStorage !== null &&
            (actual.name !== privateStorage.name || actual.createdAt !== privateStorage.createdAt)
          )
            throw new Error("Private Docker storage identity changed");
          privateStorage = actual;
        } else if (privateStorage !== null || container.privateStorageRequired)
          throw new Error("Private Docker storage ownership changed");
      } else if (container.id === null || byName !== null || container.daemonId == null) {
        throw new Error("Discovered container disappeared before ownership was verified");
      }
      // Commit this witness before the irreversible removal. A restarted reconciler can
      // then prove this same ID absent if the process dies before recording stopped_at.
      await withCancellation(
        privateStorage === null ? onIdentified(id) : onIdentified(id, privateStorage),
        deadline,
      );
      await assertDaemon();
      if (byId !== null)
        await cli(["rm", "--force", id, ...(privateStorage === null ? [] : ["--volumes"])]);
      if ((await find(`name=^/${container.name}$`)) !== null || (await find(`id=${id}`)) !== null)
        throw new Error("Container teardown was not confirmed");
      if (privateStorage !== null) await removePrivateDockerStorage(cli, privateStorage);
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
  readonly #options: CodexExecutionRuntimeOptions;
  readonly #lifecycle: CodexExecutionLifecycle;
  readonly #workspace: string;
  readonly #control: string;
  readonly #gitDirectory: string | undefined;
  #id: string | null = null;
  #daemonId: string | null = null;
  #reserved = false;
  #createMayHaveBeenIssued = false;
  #privateStorage: FactoryPrivateDockerStorage | null = null;
  #storageRecorded = false;
  #mounts: { source: string; target: string; readonly: boolean }[] = [];

  constructor(
    options: CodexExecutionRuntimeOptions,
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
  async create(
    command: readonly string[],
    commandCwd: string,
    signal: AbortSignal,
    commandTimeoutMs?: number,
  ): Promise<void> {
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
      {
        source: this.#workspace,
        target: "/workspace",
        readonly: this.#options.workspaceReadonly ?? false,
      },
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
    const resources = this.#options.containerResources ?? DEFAULT_CODEX_CONTAINER_RESOURCES;
    if (
      !Number.isSafeInteger(resources.pidsLimit) ||
      resources.pidsLimit < 1 ||
      !Number.isSafeInteger(resources.memoryBytes) ||
      resources.memoryBytes < 64 * 1024 * 1024 ||
      !Number.isSafeInteger(resources.nanoCpus) ||
      resources.nanoCpus < 1_000_000 ||
      !Number.isSafeInteger(resources.tmpfsBytes) ||
      resources.tmpfsBytes < 1024 * 1024
    )
      throw new CodexExecutionError("invalid_response");
    const availableCpus = Number(await this.cli(["info", "--format", "{{.NCPU}}"], signal));
    if (!Number.isSafeInteger(availableCpus) || availableCpus < 1)
      throw new CodexExecutionError("sandbox_unavailable");
    const cpuCount = Math.min(availableCpus, Math.ceil(resources.nanoCpus / 1_000_000_000));
    const cpuSet = cpuCount === 1 ? "0" : `0-${String(cpuCount - 1)}`;
    const executionUser =
      this.#options.containerUser ??
      `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`;
    if (!/^[1-9]\d{0,9}:[1-9]\d{0,9}$/u.test(executionUser))
      throw new CodexExecutionError("invalid_response");
    const preparedProject = this.#options.projectEnvironment === "node_docker";
    const containerUser = preparedProject ? "0:0" : executionUser;
    const shmBytes = Math.max(64 * 1024, Math.floor(resources.tmpfsBytes / 8));
    const remainingTmpfsBytes = resources.tmpfsBytes - shmBytes;
    const homeTmpfsBytes = Math.floor(remainingTmpfsBytes / 2);
    const temporaryTmpfsBytes = remainingTmpfsBytes - homeTmpfsBytes;
    if (homeTmpfsBytes < 1 || temporaryTmpfsBytes < 1)
      throw new CodexExecutionError("invalid_response");
    const temporaryTmpfs = `rw,nosuid,nodev,${preparedProject ? "exec," : ""}size=${String(temporaryTmpfsBytes)},mode=1777`;
    const homeTmpfs = `rw,nosuid,nodev,size=${String(homeTmpfsBytes)},mode=1777`;
    this.#reserved = true;
    await withCancellation(
      preparedProject
        ? this.#lifecycle.beforeContainerCreate(this.name, this.#daemonId, true)
        : this.#lifecycle.beforeContainerCreate(this.name, this.#daemonId),
      signal,
    );
    checkAbort(signal);
    await this.assertDaemon(signal);
    this.#createMayHaveBeenIssued = true;
    const id = await this.cli(
      [
        "create",
        "--pull=never",
        "--name",
        this.name,
        "--label",
        `kestrel.factory.execution=${this.name}`,
        ...(preparedProject ? ["--privileged", "--cgroupns", "private"] : ["--read-only"]),
        "--network",
        preparedProject ? "bridge" : "none",
        "--log-driver",
        "none",
        "--restart",
        "no",
        "--init",
        ...(preparedProject
          ? []
          : ["--cap-drop", "ALL", "--security-opt", "no-new-privileges:true"]),
        "--pids-limit",
        String(resources.pidsLimit),
        "--memory",
        String(resources.memoryBytes),
        "--memory-swap",
        String(resources.memoryBytes),
        "--cpus",
        String(resources.nanoCpus / 1_000_000_000),
        "--cpuset-cpus",
        cpuSet,
        "--shm-size",
        String(shmBytes),
        "--user",
        containerUser,
        "--tmpfs",
        `/tmp:${temporaryTmpfs}`,
        "--tmpfs",
        `/home/codex:${homeTmpfs}`,
        ...this.#mounts.flatMap((mount) => [
          "--mount",
          `type=bind,source=${mount.source},target=${mount.target}${mount.readonly ? ",readonly" : ""}`,
        ]),
        ...(preparedProject
          ? [
              "--mount",
              "type=volume,target=/var/lib/docker,volume-driver=local,volume-nocopy",
              "--label",
              "kestrel.factory.private-docker-storage=anonymous",
            ]
          : []),
        "--workdir",
        commandCwd,
        "--env",
        "HOME=/home/codex",
        ...(preparedProject
          ? [
              "--env",
              "DOCKER_HOST=unix:///run/kestrel-docker.sock",
              "--env",
              "DOCKER_BIN=/usr/local/bin/docker",
              "--env",
              `KESTREL_EXECUTION_USER=${executionUser}`,
              ...(commandTimeoutMs === undefined
                ? []
                : ["--env", `KESTREL_VERIFICATION_TIMEOUT_MS=${String(commandTimeoutMs)}`]),
            ]
          : []),
        "--entrypoint",
        preparedProject ? "/usr/local/bin/kestrel-project-entrypoint" : program,
        image,
        ...(preparedProject ? command : command.slice(1)),
      ],
      signal,
    );
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new CodexExecutionError("invalid_response");
    this.#id = id;
    await this.assertDaemon(signal);
    if (preparedProject) {
      const owned = await this.inspect();
      if (
        owned.id !== id ||
        owned.name !== `/${this.name}` ||
        record(owned.labels)["kestrel.factory.execution"] !== this.name ||
        record(owned.labels)["kestrel.factory.private-docker-storage"] !== "anonymous"
      )
        throw new CodexExecutionError("permission_required");
      this.#privateStorage = await privateDockerStorageFor(
        (args) => this.cli(args, signal),
        owned.mounts,
      );
    }
    await withCancellation(
      this.#lifecycle.onContainer({
        name: this.name,
        id,
        ...(this.#privateStorage === null ? {} : { privateStorage: this.#privateStorage }),
      }),
      signal,
    );
    this.#storageRecorded = true;
    const state = await this.inspect();
    const actualMounts = state.mounts;
    const actualTmpfs = record(state.tmpfs);
    if (
      state.id !== id ||
      state.name !== `/${this.name}` ||
      state.image !== image ||
      state.user !== containerUser ||
      state.running !== false ||
      state.network !== (preparedProject ? "bridge" : "none") ||
      state.logDriver !== "none" ||
      state.readonly !== !preparedProject ||
      state.privileged !== preparedProject ||
      state.pidMode !== "" ||
      (preparedProject && state.cgroupns !== "private") ||
      state.restart !== "no" ||
      state.init !== true ||
      state.pidsLimit !== resources.pidsLimit ||
      state.memory !== resources.memoryBytes ||
      state.memorySwap !== resources.memoryBytes ||
      state.nanoCpus !== resources.nanoCpus ||
      state.cpusetCpus !== cpuSet ||
      state.shmSize !== shmBytes ||
      Object.keys(actualTmpfs).length !== 2 ||
      actualTmpfs["/tmp"] !== temporaryTmpfs ||
      actualTmpfs["/home/codex"] !== homeTmpfs ||
      (!preparedProject &&
        (!Array.isArray(state.capDrop) ||
          !state.capDrop.includes("ALL") ||
          !Array.isArray(state.securityOpt) ||
          !state.securityOpt.includes("no-new-privileges:true"))) ||
      record(state.labels)["kestrel.factory.execution"] !== this.name ||
      (preparedProject &&
        record(state.labels)["kestrel.factory.private-docker-storage"] !== "anonymous") ||
      !Array.isArray(actualMounts) ||
      actualMounts.length !== this.#mounts.length + (preparedProject ? 1 : 0) ||
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
    if (this.#options.projectEnvironment === "node_docker") {
      for (let probe = 0; probe < 300; probe++) {
        try {
          await this.cli(["exec", this.id, "node", "-e", READY], signal);
          return;
        } catch {
          checkAbort(signal);
          if ((await this.inspect()).running !== true) break;
          await delay(1000, undefined, { signal });
        }
      }
      throw new CodexExecutionError("sandbox_unavailable", undefined, "project_preparation_failed");
    }
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
    const capability = randomBytes(32).toString("base64url");
    const requestTarget = `/${capability}`;
    const server = createServer((socket) => {
      if (sockets.size >= 4 || signal.aborted) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      let buffered = Buffer.alloc(0);
      let child: ReturnType<typeof spawn> | null = null;
      const authenticate = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length > 8 * 1024) {
          socket.destroy();
          return;
        }
        const headersEnd = buffered.indexOf("\r\n\r\n");
        if (headersEnd < 0) return;
        socket.off("data", authenticate);
        const requestLineEnd = buffered.indexOf("\r\n");
        const match = /^GET (\/[^ ]*) HTTP\/1\.1$/u.exec(
          buffered.subarray(0, requestLineEnd).toString("ascii"),
        );
        const received = Buffer.from(match?.[1] ?? "");
        const expected = Buffer.from(requestTarget);
        if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
          socket.destroy();
          return;
        }
        const forwardedHandshake = Buffer.concat([
          Buffer.from("GET / HTTP/1.1\r\n"),
          buffered.subarray(requestLineEnd + 2),
        ]);
        socket.setTimeout(0);
        const bridge = spawn(this.#docker, ["exec", "-i", this.id, "node", "-e", FORWARD], {
          env: safeEnvironment(),
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
        child = bridge;
        children.add(bridge);
        bridge.stdin.write(forwardedHandshake);
        socket.pipe(bridge.stdin);
        bridge.stdout.pipe(socket);
        bridge.stderr.resume();
        bridge.once("error", () => socket.destroy());
        bridge.once("close", () => {
          children.delete(bridge);
          socket.destroy();
        });
        bridge.stdin.on("error", () => socket.destroy());
      };
      socket.setTimeout(2_000, () => socket.destroy());
      socket.on("data", authenticate);
      socket.on("error", () => child?.kill("SIGKILL"));
      socket.on("close", () => {
        sockets.delete(socket);
        child?.stdin?.end();
        child?.kill("SIGKILL");
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
      url: `ws://127.0.0.1:${String(address.port)}${requestTarget}`,
      close: () => closeForwarder(server, sockets, children),
    };
  }
  async stop(): Promise<void> {
    if (!this.#reserved) return;
    let stage = "daemon_identity";
    try {
      await this.assertDaemon();
      if (this.#id === null) {
        if (!this.#createMayHaveBeenIssued) {
          stage = "persist_never_created";
          await withCancellation(
            this.#lifecycle.onStopped({ name: this.name, id: null }),
            AbortSignal.timeout(10_000),
          );
          return;
        }
        stage = "find_reserved_name";
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
        } else {
          if (this.#options.projectEnvironment === "node_docker")
            throw new Error("Required private storage was never identified");
          stage = "claim_reserved_name";
          const barrier = await this.cli(
            nameBarrierArguments(this.name, this.#options.containerImage),
          );
          if (!/^[a-f0-9]{64}$/u.test(barrier)) throw new Error("Name barrier was not confirmed");
          this.#id = barrier;
          stage = "persist_claimed_name";
          await withCancellation(
            this.#lifecycle.onContainer({ name: this.name, id: barrier }),
            AbortSignal.timeout(10_000),
          );
        }
      }
      stage = "inspect_owned_container";
      const state = await this.inspect();
      if (
        state.id !== this.#id ||
        state.name !== `/${this.name}` ||
        record(state.labels)["kestrel.factory.execution"] !== this.name
      )
        throw new Error("Container identity changed");
      if (record(state.labels)["kestrel.factory.private-docker-storage"] === "anonymous") {
        const actual = await privateDockerStorageFor((args) => this.cli(args), state.mounts);
        if (
          this.#privateStorage !== null &&
          (actual.name !== this.#privateStorage.name ||
            actual.createdAt !== this.#privateStorage.createdAt)
        )
          throw new Error("Private Docker storage identity changed");
        this.#privateStorage = actual;
        if (!this.#storageRecorded) {
          await this.#lifecycle.onContainer({
            name: this.name,
            id: this.#id,
            privateStorage: actual,
          });
          this.#storageRecorded = true;
        }
      } else if (this.#options.projectEnvironment === "node_docker")
        throw new Error("Private Docker storage ownership changed");
      // Removing the exact private PID namespace is the writer-lifetime boundary.
      // Stopping only Codex, its socket, or a docker-exec client is insufficient.
      stage = "daemon_before_remove";
      await this.assertDaemon();
      stage = "remove_owned_container";
      await this.cli([
        "rm",
        "--force",
        this.#id,
        ...(this.#privateStorage === null ? [] : ["--volumes"]),
      ]);
      stage = "confirm_name_absent";
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
      if (this.#privateStorage !== null)
        await removePrivateDockerStorage((args) => this.cli(args), this.#privateStorage);
      stage = "daemon_after_remove";
      await this.assertDaemon();
      stage = "persist_stopped";
      await withCancellation(
        this.#lifecycle.onStopped({ name: this.name, id: this.#id }),
        AbortSignal.timeout(10_000),
      );
    } catch {
      throw new CodexExecutionError("stop_unconfirmed", undefined, `teardown_${stage}_failed`);
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
  readonly transport: CodexAppServerTransport;
  readonly #input: CodexExecutionTurnInput;
  readonly #options: CodexExecutionRuntimeOptions;
  readonly #hostProfile: IsolatedCodexProfile | null;
  #threadId: string | undefined;
  #turnId: string | undefined;
  #completed = false;
  #text: string | undefined;
  #legacyText: string | undefined;
  #queue: Promise<void> = Promise.resolve();
  #queued = 0;
  #events = 0;
  readonly #seen = new Set<string>();
  readonly #children = new Map<string, { agentPath: string; turnId?: string }>();
  readonly #pendingChildren = new Map<string, Record<string, unknown>[]>();
  #resolve!: (result: CodexExecutionTurnResult) => void;
  readonly #result = new Promise<CodexExecutionTurnResult>((resolve) => {
    this.#resolve = resolve;
  });

  constructor(
    options: CodexExecutionRuntimeOptions,
    input: CodexExecutionTurnInput,
    hostCwd: string,
    url: string,
    signal: AbortSignal,
    timeoutMs: number | null,
    hostProfile: IsolatedCodexProfile | null,
  ) {
    this.#input = input;
    this.#options = options;
    this.#hostProfile = hostProfile;
    this.transport = new CodexAppServerTransport({
      profile: "turn",
      executable: options.executable ?? "codex",
      arguments: [
        ...(options.arguments ?? ["app-server", "--listen", "stdio://"]),
        ...SAFETY_ARGUMENTS,
        ...(hostProfile === null ? [] : ISOLATED_PROFILE_ARGUMENTS),
      ],
      cwd: hostCwd,
      env: {
        ...(hostProfile?.environment ?? safeEnvironment()),
        CODEX_EXEC_SERVER_URL: url,
      },
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
  #registerChild(
    item: Record<string, unknown>,
    parentThreadId: string,
    parentPath: string,
    completed: boolean,
  ): void {
    if (!completed) return;
    const id = boundedString(item.id);
    const threadId = boundedString(item.agentThreadId, 256);
    const agentPath = boundedString(item.agentPath, 256);
    const kind = boundedString(item.kind, 32);
    if (threadId === parentThreadId && agentPath === parentPath) return;
    if (
      threadId === this.#threadId ||
      !agentPath.startsWith(`${parentPath}/`) ||
      !/^\/root(?:\/[A-Za-z0-9_-]+)+$/u.test(agentPath) ||
      !["started", "interacted", "completed", "interrupted"].includes(kind)
    )
      throw new CodexExecutionError("invalid_response");
    const existing = this.#children.get(threadId);
    if (existing !== undefined && existing.agentPath !== agentPath)
      throw new CodexExecutionError("invalid_response");
    if (existing === undefined) this.#children.set(threadId, { agentPath });
    const eventKey = `${parentPath}:subagent:${id}`;
    if (!this.#seen.has(eventKey)) {
      this.#seen.add(eventKey);
      this.#enqueue(() =>
        this.#input.onActivity({
          itemId: `subagent:${threadId}:${id}`,
          kind: "subagent",
          state:
            kind === "started" || kind === "interacted"
              ? "started"
              : kind === "interrupted"
                ? "failed"
                : "completed",
          agentPath,
          summary: `Subagent ${agentPath.split("/").at(-1) ?? "agent"} ${kind}`,
        }),
      );
    }
    const pending = this.#pendingChildren.get(threadId) ?? [];
    this.#pendingChildren.delete(threadId);
    for (const message of pending) this.#receive(message);
  }
  #childEvent(method: string, params: Record<string, unknown>, threadId: string): void {
    const child = this.#children.get(threadId);
    if (child === undefined) throw new CodexExecutionError("invalid_response");
    if (method === "turn/started" || method === "turn/completed") {
      const turn = record(params.turn);
      const turnId = boundedString(turn.id);
      const status = boundedString(turn.status, 32);
      if (child.turnId !== undefined && child.turnId !== turnId)
        throw new CodexExecutionError("invalid_response");
      child.turnId = turnId;
      if (method === "turn/started") return;
      if (Array.isArray(turn.items))
        for (const item of turn.items) this.#item(item, true, threadId, child.agentPath);
      if (status === "failed" || status === "interrupted")
        this.#enqueue(() =>
          this.#input.onActivity({
            itemId: `subagent:${threadId}:turn`,
            kind: "subagent",
            state: "failed",
            agentPath: child.agentPath,
            summary: `Subagent ${child.agentPath.split("/").at(-1) ?? "agent"} ${status}`,
          }),
        );
      else if (status !== "completed") throw new CodexExecutionError("invalid_response");
      return;
    }
    if (child.turnId === undefined || params.turnId !== child.turnId)
      throw new CodexExecutionError("invalid_response");
    if (method === "error") {
      const error = protocolError(params.error);
      if (params.willRetry !== true || error.code !== "unavailable") throw error;
    } else this.#item(params.item, method === "item/completed", threadId, child.agentPath);
  }
  #receive(message: Record<string, unknown>): void {
    const method = boundedString(message.method);
    if ("id" in message) {
      if (typeof message.id !== "string" && typeof message.id !== "number")
        throw new CodexExecutionError("invalid_response");
      const params = record(message.params);
      if (params.threadId !== undefined) {
        if (params.threadId === this.#threadId) this.#observe(params.threadId, params.turnId);
        else {
          const child = this.#children.get(boundedString(params.threadId));
          if (child === undefined || child.turnId !== params.turnId)
            throw new CodexExecutionError("invalid_response");
        }
      }
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
    const eventThreadId = boundedString(params.threadId);
    if (eventThreadId !== this.#threadId) {
      if (this.#children.has(eventThreadId)) this.#childEvent(method, params, eventThreadId);
      else {
        const pending = this.#pendingChildren.get(eventThreadId) ?? [];
        if (pending.length >= 64 || this.#pendingChildren.size >= 16)
          throw new CodexExecutionError("invalid_response");
        pending.push(message);
        this.#pendingChildren.set(eventThreadId, pending);
      }
      return;
    }
    if (method === "turn/started" || method === "turn/completed") {
      const turn = record(params.turn);
      const turnId = this.#observe(params.threadId, turn.id);
      if (method === "turn/started") return;
      if (turn.status === "interrupted") throw new CodexExecutionError("interrupted");
      if (turn.status === "failed") throw protocolError(turn.error);
      if (turn.status !== "completed" || turn.error != null)
        throw new CodexExecutionError("invalid_response");
      if (Array.isArray(turn.items))
        for (const item of turn.items) this.#item(item, true, eventThreadId, "/root");
      const text = this.#text ?? this.#legacyText;
      if (text === undefined) throw new CodexExecutionError("invalid_response");
      const threadId = eventThreadId;
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
    } else this.#item(params.item, method === "item/completed", eventThreadId, "/root");
  }
  #item(value: unknown, completed: boolean, threadId: string, agentPath: string): void {
    const item = record(value);
    const type = boundedString(item.type);
    const id = boundedString(item.id);
    if (type === "subAgentActivity") {
      this.#registerChild(item, threadId, agentPath, completed);
      return;
    }
    if (["plan", "userMessage", "contextCompaction", "collabAgentToolCall"].includes(type)) return;
    if (
      !["agentMessage", "reasoning", "commandExecution", "fileChange"].includes(type) ||
      (type === "fileChange" && this.#options.allowFileChanges === false)
    )
      throw new CodexExecutionError("permission_required");
    if (type === "agentMessage" && completed && threadId === this.#threadId) {
      const text = boundedString(item.text, 128 * 1024);
      if (item.phase === "final_answer") this.#text = text;
      else if (item.phase == null) this.#legacyText = text;
      else if (item.phase !== "commentary") throw new CodexExecutionError("invalid_response");
    }
    const key = `${threadId}:${completed ? "completed" : "started"}:${id}`;
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    const reasoningSummary =
      type === "reasoning" && Array.isArray(item.summary)
        ? textPrefix(
            item.summary.filter((part): part is string => typeof part === "string").join("\n"),
          )
        : "";
    if (type === "reasoning" && !reasoningSummary.trim()) return;
    const activity: CodexExecutionActivity = {
      itemId: threadId === this.#threadId ? id : `${threadId}:${id}`,
      ...(threadId === this.#threadId ? {} : { agentPath }),
      kind:
        type === "agentMessage"
          ? "message"
          : type === "reasoning"
            ? "reasoning"
            : type === "commandExecution"
              ? "command"
              : "file_change",
      state: completed ? "completed" : "started",
      summary:
        type === "agentMessage"
          ? textPrefix(item.text ?? "")
          : type === "reasoning"
            ? reasoningSummary
            : type === "commandExecution"
              ? textPrefix(item.command ?? "Command execution")
              : "Workspace file changes",
      ...(type === "commandExecution" && completed && typeof item.aggregatedOutput === "string"
        ? { detail: textPrefix(item.aggregatedOutput, 8_192) }
        : {}),
      ...(type === "commandExecution" && completed && Number.isSafeInteger(item.exitCode)
        ? { exitCode: item.exitCode as number }
        : {}),
    };
    this.#enqueue(() => this.#input.onActivity(activity));
  }
  async run(hostCwd: string): Promise<CodexExecutionTurnResult> {
    const initialized = await this.transport
      .request("initialize", {
        clientInfo: { name: "kestrel", version: "0.0.0" },
        capabilities: { experimentalApi: true },
      })
      .then(record);
    const initializedVersion = codexVersion(initialized.userAgent);
    if (
      this.#options.expectedCodexVersion !== undefined &&
      initializedVersion !== this.#options.expectedCodexVersion
    )
      throw new CodexExecutionError("permission_required");
    if (this.#hostProfile !== null && initialized.codexHome !== this.#hostProfile.codexHome)
      throw new CodexExecutionError("permission_required");
    this.transport.notify("initialized");
    const local = await this.transport
      .request("environment/status", { environmentId: "local" })
      .then(record);
    if (local.status !== "unknown") throw new CodexExecutionError("permission_required");
    const remote = await this.transport
      .request("environment/info", { environmentId: "remote" })
      .then(record);
    if (remote.cwd !== "file:///workspace") throw new CodexExecutionError("permission_required");
    const response = await this.transport
      .request("config/read", {
        cwd: hostCwd,
        includeLayers: false,
      })
      .then(record);
    const config = record(response.config);
    const features = record(config.features);
    const mcpServers = record(config.mcp_servers ?? {});
    const modelProviders = record(config.model_providers ?? {});
    if (
      Object.entries(FEATURES).some(
        ([name, value]) => name !== "multi_agent_v2" && features[name] !== value,
      ) ||
      !isRecord(features.multi_agent_v2) ||
      features.multi_agent_v2.enabled !== true ||
      features.multi_agent_v2.max_concurrent_threads_per_session !== MAX_SUBAGENT_THREADS ||
      Object.keys(features.multi_agent_v2).some(
        (name) => !["enabled", "max_concurrent_threads_per_session"].includes(name),
      ) ||
      Object.entries(features).some(
        ([name, value]) => !(name in FEATURES) && value !== false && value !== null,
      ) ||
      config.web_search !== "disabled" ||
      config.allow_login_shell !== false ||
      (this.#hostProfile !== null &&
        (config.model !== null ||
          config.model_provider !== null ||
          Object.keys(modelProviders).length !== 0 ||
          config.model_instructions_file !== null ||
          config.instructions !== null ||
          config.project_doc_max_bytes !== 0 ||
          !Array.isArray(config.notify) ||
          config.notify.length !== 0 ||
          config.sandbox_mode !== "read-only" ||
          config.approval_policy !== "never" ||
          config.approvals_reviewer !== "user" ||
          Object.keys(mcpServers).length !== 0))
    )
      throw new CodexExecutionError("permission_required");
    const names = Object.keys(mcpServers);
    if (names.length > 256) throw new CodexExecutionError("invalid_response");
    const disabledMcpServers = Object.fromEntries(
      names.map((name) => [boundedString(name), { enabled: false }]),
    );
    const thread = await this.transport
      .request("thread/start", {
        cwd: hostCwd,
        model: this.#input.model,
        ...(this.#input.serviceTier == null ? {} : { serviceTier: this.#input.serviceTier }),
        modelProvider: "openai",
        sandbox: "read-only",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        environments: ENVIRONMENTS,
        config: {
          ...(this.#input.effort == null ? {} : { model_reasoning_effort: this.#input.effort }),
          features: TURN_FEATURES,
          model_provider: "openai",
          web_search: "disabled",
          allow_login_shell: false,
          mcp_servers: disabledMcpServers,
          shell_environment_policy: {
            // Shells inherit the remote executor's environment, not the host profile.
            // Keep configured toolchain variables, including Git's GIT_CONFIG_KEY_*.
            inherit: "all",
            ignore_default_excludes: true,
          },
        },
        developerInstructions:
          this.#options.developerInstructions ??
          (this.#options.projectEnvironment === "node_docker"
            ? "Implement only the approved scope in the selected remote workspace. The installation authorized package downloads and Docker image pulls needed for this Project's development and approved checks inside the externally contained environment. Run dependency installation, builds and integrated checks sequentially within the selected memory, CPU and process limits. Use only the remote shell to work or wait for commands; do not call host tools such as clock.sleep. Do not access unrelated external services, credentials, privileges or Git metadata writes. Resolve routine technical failures from the available requirements, code and command output; ask only when product requirements or authorization must change."
            : "Implement only the approved scope in the selected remote workspace. That environment is contained externally. Use only the remote shell to work or wait for its commands; do not call host tools such as clock.sleep. Do not access external services, privileges, or Git metadata writes. Ask when requirements or authorization must change."),
      })
      .then(record);
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
    const turn = await this.transport
      .request("turn/start", {
        threadId: this.#threadId,
        model: this.#input.model,
        ...(this.#input.effort == null ? {} : { effort: this.#input.effort }),
        ...(this.#input.serviceTier == null ? {} : { serviceTierForTurn: this.#input.serviceTier }),
        clientUserMessageId: this.#input.requestId,
        input: [{ type: "text", text: this.#input.prompt }],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "externalSandbox",
          networkAccess:
            this.#options.projectEnvironment === "node_docker" ? "enabled" : "restricted",
        },
        environments: ENVIRONMENTS,
        ...(this.#input.outputSchema === undefined
          ? {}
          : { outputSchema: this.#input.outputSchema }),
      })
      .then(record);
    this.#observe(this.#threadId, record(turn.turn).id);
    const result = await this.transport.guard(this.#result);
    return {
      ...result,
      effectiveProfile: {
        model: boundedString(thread.model),
        effort: typeof thread.reasoningEffort === "string" ? thread.reasoningEffort : null,
        serviceTier: typeof thread.serviceTier === "string" ? thread.serviceTier : null,
      },
    };
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
  options: CodexExecutionRuntimeOptions,
  input: CodexExecutionLifecycle & { signal?: AbortSignal; gitDirectory?: string },
  workspacePath: string,
  requestId: string,
  timeoutMs: number | null,
  operation: (container: ExecutionContainer, control: string, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  boundedString(requestId);
  if (
    timeoutMs !== null &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8_110_000)
  )
    throw new CodexExecutionError("invalid_response");
  if (input.signal?.aborted) throw new CodexExecutionError("cancelled");
  const controller = new AbortController();
  const timer =
    timeoutMs === null
      ? null
      : setTimeout(() => controller.abort(new CodexExecutionError("timeout")), timeoutMs);
  const signal =
    input.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, input.signal]);
  let control: string | undefined;
  let container: ExecutionContainer | undefined;
  try {
    const workspace = await existingPath(workspacePath);
    if (!(await lstat(workspace)).isDirectory()) throw new CodexExecutionError("invalid_response");
    control =
      options.controlDirectory === undefined
        ? await realpath(await mkdtemp(join(tmpdir(), "kestrel-execution-control-")))
        : await existingPath(options.controlDirectory);
    if (!(await lstat(control)).isDirectory()) throw new CodexExecutionError("invalid_response");
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
    if (timer !== null) clearTimeout(timer);
    await container?.stop();
    if (control !== undefined) await rm(control, { recursive: true, force: true });
  }
}

export function createCodexExecutionRuntime(
  options: CodexExecutionRuntimeOptions,
): CodexExecutionRuntime {
  return {
    async runTurn(input) {
      try {
        await verifyHostCodex(options);
        boundedString(input.model, 128);
        boundedString(input.prompt, 256 * 1024);
        if (
          input.outputSchema !== undefined &&
          Buffer.byteLength(JSON.stringify(input.outputSchema)) > 64 * 1024
        )
          throw new CodexExecutionError("invalid_response");
        const limit = options.timeoutMs === null ? null : timeout(options.timeoutMs ?? 120_000);
        return await isolated(
          options,
          input,
          input.cwd,
          input.requestId,
          limit,
          async (container, control, signal) => {
            const hostProfile = options.isolateHostProfile
              ? await prepareIsolatedCodexProfile(control, options.authenticationFile)
              : null;
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
            const turn = new ExecutionTurn(
              options,
              input,
              control,
              forwarder.url,
              signal,
              limit,
              hostProfile,
            );
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
        const commandTimeout = timeout(input.timeoutMs);
        const prepared = options.projectEnvironment === "node_docker";
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
          prepared ? 910_000 + commandTimeout : commandTimeout,
          async (container, _control, signal) => {
            await container.create(
              input.command,
              path === "" ? "/workspace" : `/workspace/${path.split(sep).join("/")}`,
              signal,
              prepared ? commandTimeout : undefined,
            );
            const started = performance.now();
            const result = await container.verify(signal);
            return {
              ...result,
              ...(prepared && (result.exitCode === 124 || result.exitCode === 137)
                ? { timedOut: true }
                : {}),
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
