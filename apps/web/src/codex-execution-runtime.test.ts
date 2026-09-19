import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as realDelay } from "node:timers/promises";

import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createCodexExecutionRuntime,
  type CodexExecutionRuntimeOptions,
} from "./codex-execution-runtime.js";

const directories: string[] = [];
const daemonId = "c20f7230-59a2-4824-a2f4-fda71c982ee6";
vi.setConfig({ testTimeout: 20_000 });
const fixturePath = fileURLToPath(
  new URL("./__fixtures__/codex-execution-runtime.mjs", import.meta.url),
);
const dockerFixturePath = fileURLToPath(
  new URL("./__fixtures__/codex-execution-docker.mjs", import.meta.url),
);

async function fixture(mode = "happy", runtimeOptions: Partial<CodexExecutionRuntimeOptions> = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "kestrel-execution-runtime-")));
  directories.push(cwd);
  await writeFile(join(cwd, ".git"), "gitdir: /controller-owned-fixture\n");
  const logPath = join(cwd, "protocol.jsonl");
  const dockerPath = join(cwd, "docker.mjs");
  const daemonPath = join(cwd, "daemon.json");
  await writeFile(daemonPath, JSON.stringify(daemonId));
  await writeFile(
    dockerPath,
    `#!${process.execPath}\nif (process.argv[2] === "info") { const {readFile}=await import("node:fs/promises"); console.log(JSON.parse(await readFile(${JSON.stringify(daemonPath)}, "utf8"))); } else { process.env.KESTREL_TEST_ROOT=${JSON.stringify(cwd)};process.env.KESTREL_TEST_MODE=${JSON.stringify(mode)};await import(${JSON.stringify(dockerFixturePath)}); }\n`,
    { mode: 0o700 },
  );
  return {
    cwd,
    logPath,
    daemonPath,
    runtime: createCodexExecutionRuntime({
      executable: process.execPath,
      arguments: [fixturePath, mode, logPath],
      dockerExecutable: dockerPath,
      containerImage: `sha256:${"1".repeat(64)}`,
      containerUser: "1000:1000",
      timeoutMs: 120_000,
      ...runtimeOptions,
    }),
  };
}

it("mounts review source read-only and rejects every file-change event", async () => {
  const instructions = "Inspect retained source only. Never implement or repair it.";
  const { cwd, runtime, logPath } = await fixture("happy", {
    workspaceReadonly: true,
    allowFileChanges: false,
    developerInstructions: instructions,
  });
  const turn = input(cwd);
  await expect(runtime.runTurn(turn)).rejects.toMatchObject({ code: "permission_required" });
  expect(turn.onStopped).toHaveBeenCalledOnce();
  const create = (await dockerCalls(cwd)).find((args) => args[0] === "create");
  expect(create).toContain(`type=bind,source=${cwd},target=/workspace,readonly`);
  const thread = (await protocolMessages(logPath)).find(
    (message) => message.method === "thread/start",
  );
  expect(
    z.looseObject({ developerInstructions: z.string() }).parse(thread?.params)
      .developerInstructions,
  ).toBe(instructions);
});

afterEach(async () => {
  vi.useRealTimers();
  // Failed-stop fixtures retain control files, just as production recovery requires.
  // These paths come only from this test's own subprocess invocation log.
  for (const cwd of directories) {
    const recorded = await readFile(join(cwd, "docker.jsonl"), "utf8").catch(() => "");
    for (const line of recorded.trim().split("\n").filter(Boolean)) {
      const args = z.array(z.string()).parse(JSON.parse(line));
      for (const arg of args) {
        const match =
          /^type=bind,source=(.+\/git-marker),target=\/workspace\/\.git,readonly$/u.exec(arg);
        if (
          match?.[1] !== undefined &&
          basename(dirname(match[1])).startsWith("kestrel-execution-control-")
        )
          await rm(dirname(match[1]), { recursive: true, force: true });
      }
    }
  }
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function dockerCalls(cwd: string) {
  return z.array(z.array(z.string())).parse(
    (await readFile(join(cwd, "docker.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line)),
  );
}

async function protocolMessages(logPath: string) {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
}

function input(cwd: string) {
  return {
    cwd,
    model: "fixture-model",
    requestId: "run-1:implementation:1",
    prompt: "Implement the approved feature.",
    beforeContainerCreate: vi.fn(() => Promise.resolve()),
    onContainer: vi.fn(() => Promise.resolve()),
    onStopped: vi.fn(() => Promise.resolve()),
    onThread: vi.fn(() => Promise.resolve()),
    onTurn: vi.fn(() => Promise.resolve()),
    onActivity: vi.fn(() => Promise.resolve()),
    onQuestion: vi.fn(() => Promise.resolve()),
  };
}

it("persists the selected Docker Engine identity before the container can be created", async () => {
  const { cwd, runtime } = await fixture();
  const turn = input(cwd);
  await runtime.runTurn(turn);
  expect(turn.beforeContainerCreate).toHaveBeenCalledWith(
    expect.stringMatching(/^kestrel-factory-/u),
    daemonId,
  );
});

it("rejects a local bridge client without the per-run capability before docker exec", async () => {
  const { cwd, runtime, logPath } = await fixture("bridge_probe");
  await runtime.runTurn(input(cwd));

  expect(await protocolMessages(logPath)).toContainEqual({ unauthorizedBridgeClosed: true });
  expect((await dockerCalls(cwd)).some((args) => args[0] === "exec" && args.includes("-i"))).toBe(
    false,
  );
});

it("authenticates the per-run bridge capability and hides it from the contained server", async () => {
  const { cwd, runtime, logPath } = await fixture("bridge_authorized_probe");
  await runtime.runTurn(input(cwd));

  expect(await protocolMessages(logPath)).toContainEqual({ bridgeForwardedRoot: true });
  expect(
    (await dockerCalls(cwd)).filter((args) => args[0] === "exec" && args.includes("-i")),
  ).toHaveLength(1);
});

it("rejects a root container identity before reserving an environment", async () => {
  const { cwd, runtime } = await fixture("happy", { containerUser: "0:0" });
  const turn = input(cwd);

  await expect(runtime.runTurn(turn)).rejects.toMatchObject({ code: "invalid_response" });

  expect(turn.beforeContainerCreate).not.toHaveBeenCalled();
  expect((await dockerCalls(cwd)).some((args) => args[0] === "create")).toBe(false);
});

it("rejects a changed host Codex executable before reserving an environment", async () => {
  const { cwd, runtime } = await fixture("happy", {
    expectedExecutableDigest: "f".repeat(64),
    expectedCodexVersion: "0.155.1",
  });
  const turn = input(cwd);

  await expect(runtime.runTurn(turn)).rejects.toMatchObject({
    code: "sandbox_unavailable",
    reason: "runtime_profile_mismatch",
  });

  expect(turn.beforeContainerCreate).not.toHaveBeenCalled();
});

it("rejects a host Codex version different from the frozen runtime profile", async () => {
  const executableDigest = createHash("sha256")
    .update(await readFile(process.execPath))
    .digest("hex");
  const { cwd, runtime } = await fixture("happy", {
    expectedExecutableDigest: executableDigest,
    expectedCodexVersion: "0.999.0",
  });
  const turn = input(cwd);

  await expect(runtime.runTurn(turn)).rejects.toMatchObject({ code: "permission_required" });

  expect(turn.onStopped).toHaveBeenCalledOnce();
  expect(turn.onThread).not.toHaveBeenCalled();
});

it("uses and removes a caller-owned deterministic control directory after confirmed teardown", async () => {
  const initial = await fixture();
  const control = join(initial.cwd, "review-controls", "attempt-1");
  await mkdir(control, { recursive: true, mode: 0o700 });
  const runtime = createCodexExecutionRuntime({
    dockerExecutable: join(initial.cwd, "docker.mjs"),
    containerImage: `sha256:${"1".repeat(64)}`,
    timeoutMs: 120_000,
    controlDirectory: control,
    executable: process.execPath,
    arguments: [fixturePath, "happy", initial.logPath],
  });

  await runtime.runTurn(input(initial.cwd));

  await expect(lstat(control)).rejects.toMatchObject({ code: "ENOENT" });
});

it("runs Codex from a minimal per-attempt host profile containing only copied authentication", async () => {
  const initial = await fixture();
  const operatorProfile = join(initial.cwd, "operator-profile");
  const authenticationFile = join(operatorProfile, "auth.json");
  const notifierCanary = join(initial.cwd, "operator-notifier-ran");
  await mkdir(operatorProfile, { recursive: true, mode: 0o700 });
  await writeFile(authenticationFile, "{}", { mode: 0o600 });
  await writeFile(
    join(operatorProfile, "config.toml"),
    `instructions = "OPERATOR_PROFILE_CANARY"\nnotify = ["touch", ${JSON.stringify(notifierCanary)}]\n`,
  );
  await writeFile(join(operatorProfile, "AGENTS.md"), "OPERATOR_PROFILE_CANARY\n");
  const runtime = createCodexExecutionRuntime({
    dockerExecutable: join(initial.cwd, "docker.mjs"),
    containerImage: `sha256:${"1".repeat(64)}`,
    timeoutMs: 120_000,
    executable: process.execPath,
    arguments: [fixturePath, "happy", initial.logPath],
    isolateHostProfile: true,
    authenticationFile,
  });

  await runtime.runTurn(input(initial.cwd));

  const profile = z
    .object({
      codexHome: z.string(),
      home: z.string(),
      xdgConfigHome: z.string(),
      entries: z.array(z.string()),
      config: z.string(),
      authenticationPresent: z.boolean(),
    })
    .parse((await protocolMessages(initial.logPath))[0]?.hostProfile);
  expect(profile.codexHome).not.toBe(operatorProfile);
  expect(profile.codexHome).toContain("host-profile/codex");
  expect(profile.home).toContain("host-profile/home");
  expect(profile.xdgConfigHome).toContain("host-profile/xdg");
  expect(profile.entries).toEqual(["auth.json", "config.toml"]);
  expect(profile.config).toBe("project_doc_max_bytes = 0\n");
  expect(profile.authenticationPresent).toBe(true);
  expect(
    z
      .object({ args: z.array(z.string()) })
      .parse((await protocolMessages(initial.logPath))[0])
      .args.join(" "),
  ).toContain("-c project_doc_max_bytes=0");
  await expect(lstat(notifierCanary)).rejects.toMatchObject({ code: "ENOENT" });
});

it("fails closed when an isolated Codex profile reports project instruction discovery enabled", async () => {
  const initial = await fixture("project_docs_enabled");
  const operatorProfile = join(initial.cwd, "operator-profile");
  const authenticationFile = join(operatorProfile, "auth.json");
  await mkdir(operatorProfile, { recursive: true, mode: 0o700 });
  await writeFile(authenticationFile, "{}", { mode: 0o600 });
  const runtime = createCodexExecutionRuntime({
    dockerExecutable: join(initial.cwd, "docker.mjs"),
    containerImage: `sha256:${"1".repeat(64)}`,
    timeoutMs: 120_000,
    executable: process.execPath,
    arguments: [fixturePath, "project_docs_enabled", initial.logPath],
    isolateHostProfile: true,
    authenticationFile,
  });
  const turn = input(initial.cwd);

  await expect(runtime.runTurn(turn)).rejects.toMatchObject({ code: "permission_required" });

  expect(turn.onStopped).toHaveBeenCalledOnce();
  expect(turn.onThread).not.toHaveBeenCalled();
  expect(
    (await protocolMessages(initial.logPath)).some((message) => message.method === "turn/start"),
  ).toBe(false);
});

it("retains an uncertain reservation when Docker changes after its durable create intent", async () => {
  const { cwd, runtime, daemonPath } = await fixture();
  const turn = {
    ...input(cwd),
    beforeContainerCreate: async () => {
      await writeFile(daemonPath, JSON.stringify("other-daemon"));
    },
  };
  await expect(runtime.runTurn(turn)).rejects.toMatchObject({ code: "stop_unconfirmed" });
  expect(turn.onStopped).not.toHaveBeenCalled();
  expect((await dockerCalls(cwd)).some((args) => args[0] === "create")).toBe(false);
});

it("settles durable container intent before honoring cancellation and starting teardown", async () => {
  const { cwd, runtime } = await fixture();
  const controller = new AbortController();
  let release!: () => void;
  let announce!: () => void;
  const announced = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const turn = {
    ...input(cwd),
    signal: controller.signal,
    beforeContainerCreate: () => {
      announce();
      return pending;
    },
  };
  const running = runtime.runTurn(turn).then(
    () => "completed",
    (error: unknown) => z.object({ code: z.string() }).parse(error).code,
  );
  await announced;
  controller.abort();
  const result = await Promise.race([
    running,
    realDelay(100, undefined, { ref: false }).then(() => "pending"),
  ]);
  expect(result).toBe("pending");
  release();
  expect(await running).toBe("cancelled");
  expect(turn.onContainer).not.toHaveBeenCalled();
  expect(turn.onStopped).toHaveBeenCalledWith(expect.objectContaining({ id: null }));
});

it.each(["beforeContainerCreate", "onThread"] as const)(
  "observes a rejected %s callback when it cancels the execution synchronously",
  async (callback) => {
    const { cwd, runtime } = await fixture();
    const controller = new AbortController();
    const turn = input(cwd);
    const rejectAndCancel = () => {
      controller.abort();
      return Promise.reject(new Error("Fixture persistence cancelled"));
    };
    await expect(
      runtime.runTurn({ ...turn, signal: controller.signal, [callback]: rejectAndCancel }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(turn.onStopped).toHaveBeenCalledOnce();
  },
);

it("retains the writer reservation and does not remove a container whose captured identity fails verification", async () => {
  const { cwd, runtime } = await fixture("foreign_container");
  const turn = input(cwd);
  await expect(runtime.runTurn(turn)).rejects.toMatchObject({ code: "stop_unconfirmed" });
  expect(turn.onStopped).not.toHaveBeenCalled();
  const calls = z.array(z.array(z.string())).parse(
    (await readFile(join(cwd, "docker.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line)),
  );
  expect(calls.some((args) => args[0] === "rm")).toBe(false);
});

it.each(["unsafe_container", "local_enabled", "unknown_feature"])(
  "rejects %s before inference and still destroys its owned container",
  async (mode) => {
    const { cwd, runtime, logPath } = await fixture(mode);
    const turn = input(cwd);
    await expect(runtime.runTurn(turn)).rejects.toMatchObject({ code: "permission_required" });
    expect(turn.onStopped).toHaveBeenCalledOnce();
    expect(turn.onThread).not.toHaveBeenCalled();
    const messages = await protocolMessages(logPath).catch(() => []);
    expect(messages.some((message) => message.method === "turn/start")).toBe(false);
  },
);

it.each([
  "limit_user",
  "limit_pids",
  "limit_memory",
  "limit_swap",
  "limit_cpu",
  "limit_shm",
  "limit_tmpfs",
  "limit_log",
])("fails closed when Docker does not apply %s", async (mode) => {
  const { cwd, runtime, logPath } = await fixture(mode);
  const turn = input(cwd);
  await expect(runtime.runTurn(turn)).rejects.toMatchObject({ code: "permission_required" });
  expect(turn.onStopped).toHaveBeenCalledOnce();
  expect(await protocolMessages(logPath).catch(() => [])).toHaveLength(0);
});

it.each([
  ["authentication", "authentication"],
  ["malformed", "invalid_response"],
  ["wrong_turn", "invalid_response"],
  ["only_delta", "invalid_response"],
  ["forbidden_tool", "permission_required"],
  ["exit", "interrupted"],
])("reports %s without publishing partial output or raw errors", async (mode, code) => {
  const { cwd, runtime } = await fixture(mode);
  const turn = input(cwd);
  await expect(runtime.runTurn(turn)).rejects.toMatchObject({
    code,
    message: `Codex execution failed: ${code}`,
    question: undefined,
  });
  expect(turn.onStopped).toHaveBeenCalledOnce();
});

it.each([
  ["question", "input_required", "Which export format is approved?"],
  [
    "secret_question",
    "input_required",
    "Codex requested sensitive input. Configure its authentication directly before retrying.",
  ],
  [
    "permission",
    "permission_required",
    "The execution requested additional permissions. Review the approved scope before continuing.",
  ],
])(
  "persists a real %s gate and denies an unapproved answer or permission",
  async (mode, code, question) => {
    const { cwd, runtime, logPath } = await fixture(mode);
    const turn = input(cwd);
    await expect(runtime.runTurn(turn)).rejects.toMatchObject({ code, question });
    expect(turn.onQuestion).toHaveBeenCalledWith({ code, question });
    expect(turn.onStopped).toHaveBeenCalledOnce();
    const messages = await protocolMessages(logPath);
    expect(messages.some((message) => message.method === "turn/interrupt")).toBe(true);
    expect(
      messages.find(
        (message) => message.id === (mode === "permission" ? "permission" : "question"),
      ),
    ).toMatchObject({
      result: mode === "permission" ? { permissions: {}, scope: "turn" } : { answers: {} },
    });
  },
);

it("reconciles a lost create response without ever starting or creating a second container", async () => {
  const { cwd, runtime } = await fixture("create_uncertain");
  const turn = input(cwd);
  await expect(runtime.runTurn(turn)).rejects.toMatchObject({ code: "sandbox_unavailable" });
  expect(turn.onContainer).not.toHaveBeenCalled();
  expect(turn.onStopped).toHaveBeenCalledWith(expect.objectContaining({ id: "a".repeat(64) }));
  const calls = await dockerCalls(cwd);
  expect(calls.filter((args) => args[0] === "create")).toHaveLength(1);
  expect(calls.some((args) => args[0] === "start")).toBe(false);
  expect(calls.filter((args) => args[0] === "rm")).toHaveLength(1);
});

it("claims the reserved name before reporting an uncertain absent create as stopped", async () => {
  const { cwd, runtime } = await fixture("create_uncertain_absent");
  const turn = input(cwd);
  await expect(runtime.runTurn(turn)).rejects.toMatchObject({ code: "sandbox_unavailable" });
  expect(turn.onContainer).toHaveBeenCalledWith(expect.objectContaining({ id: "a".repeat(64) }));
  expect(turn.onStopped).toHaveBeenCalledWith(expect.objectContaining({ id: "a".repeat(64) }));
  const calls = await dockerCalls(cwd);
  expect(calls.filter((args) => args[0] === "create")).toHaveLength(2);
  expect(
    calls.some(
      (args) => args[0] === "create" && args.includes("--entrypoint") && args.includes("/bin/true"),
    ),
  ).toBe(true);
  expect(calls.some((args) => args[0] === "start")).toBe(false);
  expect(calls.filter((args) => args[0] === "rm")).toHaveLength(1);
});

it("never reports success or releases its reservation when container shutdown is uncertain", async () => {
  const { cwd, runtime } = await fixture("shutdown_uncertain");
  const turn = input(cwd);
  await expect(runtime.runTurn(turn)).rejects.toMatchObject({
    code: "stop_unconfirmed",
    question: undefined,
  });
  expect(turn.onStopped).not.toHaveBeenCalled();
});

it("reports an absent immutable image before reserving or creating any environment", async () => {
  const { cwd, runtime } = await fixture("image_missing");
  const turn = input(cwd);
  await expect(runtime.runTurn(turn)).rejects.toMatchObject({
    code: "sandbox_unavailable",
    reason: "image_unavailable",
  });
  expect(turn.beforeContainerCreate).not.toHaveBeenCalled();
  expect(turn.onStopped).not.toHaveBeenCalled();
  expect((await dockerCalls(cwd)).some((args) => args[0] === "create")).toBe(false);
});

it("does not dispatch inference until thread persistence succeeds", async () => {
  const { cwd, runtime, logPath } = await fixture();
  const turn = {
    ...input(cwd),
    onThread: () => Promise.reject(new Error("Private database failure")),
  };
  await expect(runtime.runTurn(turn)).rejects.toMatchObject({ code: "unavailable" });
  expect((await protocolMessages(logPath)).some((message) => message.method === "turn/start")).toBe(
    false,
  );
  expect(turn.onStopped).toHaveBeenCalledOnce();
});

it("does not start its container when identity persistence fails", async () => {
  const { cwd, runtime } = await fixture();
  const turn = {
    ...input(cwd),
    onContainer: () => Promise.reject(new Error("Private database failure")),
  };
  await expect(runtime.runTurn(turn)).rejects.toMatchObject({ code: "unavailable" });
  expect((await dockerCalls(cwd)).some((args) => args[0] === "start")).toBe(false);
  expect(turn.onStopped).toHaveBeenCalledOnce();
});

it("runs exact verification argv in a separate container and preserves nonzero outcomes", async () => {
  const { cwd, runtime } = await fixture("verification_failed");
  const lifecycle = input(cwd);
  const command = ["node", "--test", "tests/a; echo untouched $(false).test.mjs"];
  const result = await runtime.runVerification({
    ...lifecycle,
    workspaceCwd: cwd,
    cwd: ".",
    command,
    processId: "run-1:verification:1:1",
    timeoutMs: 7_200_000,
  });
  expect(result).toMatchObject({
    processId: "run-1:verification:1:1",
    exitCode: 7,
    stdout: "verified 🪶\n",
    stderr: "check details\n",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  const create = (await dockerCalls(cwd)).find((args) => args[0] === "create");
  if (create === undefined) throw new Error("Expected container creation");
  expect(create.slice(create.indexOf("--entrypoint") + 1)).toEqual([
    command[0],
    `sha256:${"1".repeat(64)}`,
    ...command.slice(1),
  ]);
  expect(lifecycle.onStopped).toHaveBeenCalledOnce();
});

it("retains bounded verification output with explicit truncation flags", async () => {
  const { cwd, runtime } = await fixture("output_cap");
  const result = await runtime.runVerification({
    ...input(cwd),
    workspaceCwd: cwd,
    cwd: ".",
    command: ["node", "check.mjs"],
    processId: "check-output",
    timeoutMs: 10_000,
  });
  expect(Buffer.byteLength(result.stdout)).toBe(65_536);
  expect(Buffer.byteLength(result.stderr)).toBe(65_536);
  expect(result).toMatchObject({ exitCode: 0, stdoutTruncated: true, stderrTruncated: true });
});

it("never treats a container that failed to start as a successful verification", async () => {
  const { cwd, runtime } = await fixture("verification_start_rejected");
  const lifecycle = input(cwd);
  await expect(
    runtime.runVerification({
      ...lifecycle,
      workspaceCwd: cwd,
      cwd: ".",
      command: ["node", "check.mjs"],
      processId: "rejected-start",
      timeoutMs: 60_000,
    }),
  ).rejects.toMatchObject({ code: "sandbox_unavailable", reason: "verification_not_started" });
  expect(lifecycle.onStopped).toHaveBeenCalledOnce();
});

it.each(["..", "symlink"])(
  "rejects a verification cwd escaping through %s before container creation",
  async (mode) => {
    const { cwd, runtime } = await fixture();
    if (mode === "symlink") await symlink(tmpdir(), join(cwd, "escape"));
    await expect(
      runtime.runVerification({
        ...input(cwd),
        workspaceCwd: cwd,
        cwd: mode === "symlink" ? "escape" : "..",
        command: ["node", "check.mjs"],
        processId: "check-escape",
        timeoutMs: 10_000,
      }),
    ).rejects.toMatchObject({ code: "permission_required" });
    await expect(readFile(join(cwd, "docker.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("reports an unavailable verification workspace without exposing its host path", async () => {
  const { cwd, runtime } = await fixture();
  const result = runtime.runVerification({
    ...input(cwd),
    workspaceCwd: join(cwd, "missing-private-source"),
    cwd: ".",
    command: ["node", "check.mjs"],
    processId: "missing-path",
    timeoutMs: 60_000,
  });
  await expect(result).rejects.toMatchObject({
    name: "CodexExecutionError",
    code: "sandbox_unavailable",
    reason: "workspace_unavailable",
    message: "Codex execution failed: sandbox_unavailable (workspace_unavailable)",
  });
});

it("interrupts a cancelled active turn and proves container removal before returning", async () => {
  const { cwd, runtime, logPath } = await fixture("stall");
  const controller = new AbortController();
  const turn = {
    ...input(cwd),
    signal: controller.signal,
    onTurn: () => {
      controller.abort();
      return Promise.resolve();
    },
  };
  await expect(runtime.runTurn(turn)).rejects.toMatchObject({ code: "cancelled" });
  expect(turn.onStopped).toHaveBeenCalledOnce();
  expect(
    (await protocolMessages(logPath)).some((message) => message.method === "turn/interrupt"),
  ).toBe(true);
});

it("reports a real deadline as timeout rather than ordinary cancellation", async () => {
  const { cwd, runtime } = await fixture("stall");
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const turn = {
    ...input(cwd),
    onTurn: () => {
      started();
      return Promise.resolve();
    },
  };
  const running = runtime.runTurn(turn).then(
    () => "completed",
    (error: unknown) => z.object({ code: z.string() }).parse(error).code,
  );
  await ready;
  vi.advanceTimersByTime(120_000);
  vi.useRealTimers();
  expect(await running).toBe("timeout");
  expect(turn.onStopped).toHaveBeenCalledOnce();
});

it("persists container intent before creation and stops the isolated writer before returning its completed turn", async () => {
  const { cwd, logPath, runtime } = await fixture();
  const lifecycle: string[] = [];
  const outputSchema = {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  };
  const result = await runtime.runTurn({
    cwd,
    model: "fixture-model",
    requestId: "a74156de-fbd7-4268-90e3-c5b721348393",
    prompt: "Implement the approved feature.",
    outputSchema,
    beforeContainerCreate: async (name) => {
      expect(name).toMatch(/^kestrel-factory-[a-f0-9]+$/u);
      await expect(readFile(join(cwd, "container.json"))).rejects.toMatchObject({ code: "ENOENT" });
      lifecycle.push("intent");
    },
    onContainer: async () => {
      expect(
        z
          .object({ running: z.boolean() })
          .parse(JSON.parse(await readFile(join(cwd, "container.json"), "utf8"))).running,
      ).toBe(false);
      lifecycle.push("container");
    },
    onStopped: async () => {
      expect(
        z
          .object({ running: z.boolean() })
          .parse(JSON.parse(await readFile(join(cwd, "container.json"), "utf8"))).running,
      ).toBe(false);
      lifecycle.push("stopped");
    },
    onThread: () => {
      lifecycle.push("thread");
      return Promise.resolve();
    },
    onTurn: () => {
      lifecycle.push("turn");
      return Promise.resolve();
    },
    onActivity: () => {
      lifecycle.push("activity");
      return Promise.resolve();
    },
    onQuestion: () => {
      return Promise.reject(new Error("Unexpected question"));
    },
  });
  expect(result).toEqual({
    threadId: "execution-thread",
    turnId: "execution-turn",
    text: "Implemented. 🪶",
  });
  expect(lifecycle.slice(0, 4)).toEqual(["intent", "container", "thread", "turn"]);
  expect(lifecycle.at(-1)).toBe("stopped");
  const recorded = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
  expect(recorded.find((entry) => entry.method === "turn/start")).toMatchObject({
    params: {
      outputSchema,
      sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" },
      environments: [
        { environmentId: "remote", cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
      ],
    },
  });
  expect(recorded.find((entry) => entry.method === "thread/start")).toMatchObject({
    params: { config: { mcp_servers: { "private.connector": { enabled: false } } } },
  });
  expect(JSON.stringify(recorded)).not.toContain("secret_fixture_value");
  expect(
    recorded.some(
      (entry) => entry.method === "command/exec" || entry.method === "thread/shellCommand",
    ),
  ).toBe(false);
});
import { createHash } from "node:crypto";
