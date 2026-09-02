import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const runningChildren: ChildProcess[] = [];

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not allocate a loopback test port");
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
  });
  return address.port;
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source, { mode: 0o755 });
  await chmod(path, 0o755);
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function waitForOutput(
  child: ChildProcess,
  readOutput: () => string,
  expected: string,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      rejectPromise(new Error(`Timed out waiting for launcher output: ${readOutput()}`));
    }, 10_000);
    const inspect = () => {
      if (readOutput().includes(expected)) {
        clearTimeout(timeout);
        resolvePromise();
      }
    };
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("close", (code) => {
      clearTimeout(timeout);
      rejectPromise(
        new Error(`Launcher exited with ${String(code)} before readiness: ${readOutput()}`),
      );
    });
  });
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
}

afterEach(async () => {
  for (const child of runningChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          continue;
        } catch {
          // Fall through to the direct child when its process group is already gone.
        }
      }
      child.kill("SIGKILL");
    }
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("supported local development lifecycle", () => {
  it("stops Compose infrastructure without deleting Kestrel-owned state", async () => {
    if (npmCli === undefined)
      throw new Error("npm did not expose its CLI path to the test process");
    const fixture = await realpath(await mkdtemp(join(tmpdir(), "kestrel-local-down-")));
    temporaryDirectories.push(fixture);
    const docker = join(fixture, "docker");
    const logPath = join(fixture, "docker.json");
    const retainedState = join(fixture, "retained-state");
    await writeFile(retainedState, "keep\n", "utf8");
    await writeExecutable(
      docker,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.KESTREL_LIFECYCLE_TEST_LOG, JSON.stringify(process.argv.slice(2)));
`,
    );

    await execFileAsync(process.execPath, [npmCli, "run", "dev:down"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        DOCKER_BIN: docker,
        KESTREL_LIFECYCLE_TEST_LOG: logPath,
      },
    });

    await expect(readFile(logPath, "utf8").then(parseJson)).resolves.toEqual([
      "compose",
      "-f",
      "compose.yaml",
      "down",
    ]);
    await expect(readFile(retainedState, "utf8")).resolves.toBe("keep\n");
  });

  it.each(["bootstrap", "reset-password"])(
    "runs %s from the trusted host instead of an application container",
    async (command) => {
      if (npmCli === undefined) {
        throw new Error("npm did not expose its CLI path to the test process");
      }
      const fixture = await realpath(await mkdtemp(join(tmpdir(), "kestrel-local-command-")));
      temporaryDirectories.push(fixture);
      const tools = join(fixture, "tools");
      const stateRoot = join(fixture, "state");
      const logPath = join(fixture, "command.json");
      await import("node:fs/promises").then(({ mkdir }) => mkdir(tools));
      await writeExecutable(
        join(tools, "npm"),
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.KESTREL_LIFECYCLE_TEST_LOG, JSON.stringify({
  args: process.argv.slice(2),
  databaseUrl: process.env.DATABASE_URL,
  host: process.env.HOST
}));
`,
      );
      await writeExecutable(join(tools, "git"), "#!/usr/bin/env node\n");

      await execFileAsync(process.execPath, [npmCli, "run", command], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          DOCKER_BIN: join(tools, "missing-docker"),
          KESTREL_DATABASE_PORT: "55432",
          KESTREL_LIFECYCLE_TEST_LOG: logPath,
          KESTREL_STATE_ROOT: stateRoot,
          PATH: `${tools}:${process.env.PATH ?? ""}`,
        },
      });

      await expect(readFile(logPath, "utf8").then(parseJson)).resolves.toEqual({
        args: ["run", command, "-w", "@kestrel/web"],
        databaseUrl: "postgres://kestrel_runtime:kestrel_runtime_dev@127.0.0.1:55432/kestrel",
        host: "127.0.0.1",
      });
    },
  );

  it("runs only database preparation in Compose and supervises loopback host processes", async () => {
    if (npmCli === undefined)
      throw new Error("npm did not expose its CLI path to the test process");
    const fixture = await realpath(await mkdtemp(join(tmpdir(), "kestrel-local-development-")));
    temporaryDirectories.push(fixture);
    const tools = join(fixture, "tools");
    const dockerTools = join(fixture, "docker-tools");
    const stateRoot = join(fixture, "state");
    const logPath = join(fixture, "lifecycle.jsonl");
    await import("node:fs/promises").then(async ({ mkdir }) => {
      await Promise.all([mkdir(tools), mkdir(dockerTools)]);
    });

    const recorder = `
import { appendFileSync, chmodSync } from "node:fs";
import { delimiter, dirname } from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.KESTREL_LIFECYCLE_TEST_LOG, JSON.stringify({
  args,
  artifactRoot: process.env.KESTREL_ARTIFACT_ROOT,
  dockerDirectoryFirstOnPath: process.env.PATH.split(delimiter)[0] === dirname(process.argv[1]),
  hasSessionSigningKey: Boolean(process.env.SESSION_SIGNING_KEY),
  kind: "docker",
  modelProviderSecretRoot: process.env.KESTREL_MODEL_PROVIDER_SECRET_ROOT
}) + "\\n");
if (args.at(-1) === "legacy-state-import") {
  chmodSync(process.env.KESTREL_ARTIFACT_ROOT, 0o755);
  chmodSync(process.env.KESTREL_MODEL_PROVIDER_SECRET_ROOT, 0o755);
}
`;
    await writeExecutable(join(dockerTools, "docker"), `#!/usr/bin/env node\n${recorder}`);

    const hostProcess = `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, constants, accessSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);
const workspaceIndex = args.indexOf("-w");
const workspace = workspaceIndex === -1 ? "build" : args[workspaceIndex + 1];
const service = workspace === "@kestrel/web" ? "web" :
  workspace === "@kestrel/worker" ? "worker" :
  workspace === "@kestrel/pwa" ? "pwa" : "build";
let resolvedHostTools = false;
if (service !== "build") {
  if (service === "web") accessSync(process.env.LOCAL_GIT_EXECUTABLE, constants.X_OK);
  for (const tool of ["git", "gh", "codex"]) execFileSync(tool, ["--version"]);
  resolvedHostTools = true;
}
const record = (phase, signal) => appendFileSync(
  process.env.KESTREL_LIFECYCLE_TEST_LOG,
  JSON.stringify({
    args,
    artifactRoot: process.env.ARTIFACT_ROOT,
    databaseUrl: process.env.DATABASE_URL,
    ghExecutable: process.env.KESTREL_GH_EXECUTABLE,
    gitExecutable: process.env.LOCAL_GIT_EXECUTABLE,
    hasModelProviderSecretRoot: Boolean(process.env.MODEL_PROVIDER_SECRET_ROOT),
    hasSessionSigningKey: Boolean(process.env.SESSION_SIGNING_KEY),
    host: process.env.HOST,
    kind: "npm",
    modelProviderSecretRoot: process.env.MODEL_PROVIDER_SECRET_ROOT,
    phase,
    repositoryRoots: process.env.LOCAL_REPOSITORY_ROOTS,
    repositoryRootsFile: process.env.LOCAL_REPOSITORY_ROOTS_FILE,
    resolvedHostTools,
    service,
    signal
  }) + "\\n"
);
record("start");
if (service === "build") process.exit(0);
if (service === "worker") {
  setTimeout(() => {
    record("ready");
    console.log(JSON.stringify({ event: "worker.started" }));
  }, 250);
}

let server;
if (service === "web" || service === "pwa") {
  const portArgument = args.indexOf("--port");
  const port = service === "web" ? Number(process.env.PORT) : Number(args[portArgument + 1]);
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  server.listen(port, "127.0.0.1");
}

const stop = (signal) => {
  if (service === "pwa" && !args.includes("--silent")) {
    console.error("npm error Lifecycle script failed");
  }
  record("stop", signal);
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
setInterval(() => undefined, 1_000);
`;
    await writeExecutable(join(tools, "npm"), hostProcess);
    for (const tool of ["git", "gh", "codex"]) {
      await writeExecutable(
        join(tools, tool),
        `#!/usr/bin/env node\nif (process.argv[2] === "--version") console.log("${tool} test");\n`,
      );
    }

    const [databasePort, webPort, pwaPort] = await Promise.all([
      allocateLoopbackPort(),
      allocateLoopbackPort(),
      allocateLoopbackPort(),
    ]);
    let output = "";
    const child = spawn(process.execPath, [npmCli, "run", "dev"], {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        DOCKER_BIN: join(dockerTools, "docker"),
        KESTREL_DATABASE_PORT: String(databasePort),
        KESTREL_LIFECYCLE_TEST_LOG: logPath,
        KESTREL_GH_EXECUTABLE: "/untrusted/inherited-gh",
        KESTREL_PWA_PORT: String(pwaPort),
        KESTREL_STARTUP_TIMEOUT_MS: "5000",
        KESTREL_STATE_ROOT: stateRoot,
        KESTREL_WEB_PORT: String(webPort),
        PATH: `${tools}:${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    runningChildren.push(child);
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));

    await waitForOutput(child, () => output, "Kestrel is ready");
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGINT");
    else child.kill("SIGINT");
    const result = await Promise.race([
      waitForExit(child),
      new Promise<never>((_resolvePromise, rejectPromise) => {
        setTimeout(
          () =>
            rejectPromise(
              new Error(
                `Timed out waiting for npm to exit (code=${String(child.exitCode)}, signal=${String(child.signalCode)}): ${output}`,
              ),
            ),
          2_000,
        );
      }),
    ]);
    expect(result.code === 0 || result.signal === "SIGINT").toBe(true);

    const entries = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const dockerEntries = entries.filter((entry) => entry.kind === "docker");
    expect(dockerEntries.map((entry) => entry.args)).toEqual([
      [
        "compose",
        "-f",
        "compose.yaml",
        "-f",
        "compose.local.yaml",
        "rm",
        "--stop",
        "--force",
        "web",
        "worker",
        "pwa",
      ],
      ["compose", "-f", "compose.yaml", "-f", "compose.local.yaml", "build", "migrate"],
      [
        "compose",
        "-f",
        "compose.yaml",
        "-f",
        "compose.local.yaml",
        "up",
        "--detach",
        "--wait",
        "postgres",
      ],
      [
        "compose",
        "-f",
        "compose.yaml",
        "-f",
        "compose.local.yaml",
        "run",
        "--rm",
        "--no-deps",
        "migrate",
      ],
      [
        "compose",
        "-f",
        "compose.yaml",
        "-f",
        "compose.local.yaml",
        "run",
        "--rm",
        "--no-deps",
        "database-role",
      ],
      [
        "compose",
        "-f",
        "compose.yaml",
        "-f",
        "compose.local.yaml",
        "run",
        "--rm",
        "--no-deps",
        "legacy-state-import",
      ],
    ]);
    expect(
      dockerEntries.every(
        (entry) =>
          entry.artifactRoot === join(stateRoot, "review-artifacts") &&
          entry.dockerDirectoryFirstOnPath === true &&
          entry.hasSessionSigningKey === true &&
          entry.modelProviderSecretRoot === join(stateRoot, "model-provider-secrets"),
      ),
    ).toBe(true);
    const startedServices = entries
      .filter((entry) => entry.kind === "npm" && entry.phase === "start")
      .map((entry) => entry.service);
    expect(startedServices[0]).toBe("build");
    expect(startedServices.slice(1).sort()).toEqual(["pwa", "web", "worker"]);
    expect(
      entries.some(
        (entry) => entry.kind === "npm" && entry.phase === "ready" && entry.service === "worker",
      ),
    ).toBe(true);
    expect(
      entries
        .filter(
          (entry) => entry.kind === "npm" && entry.phase === "start" && entry.service !== "build",
        )
        .every((entry) => entry.resolvedHostTools === true),
    ).toBe(true);
    expect(
      entries
        .filter((entry) => entry.kind === "npm" && entry.phase === "stop")
        .map((entry) => entry.service)
        .sort(),
    ).toEqual(["pwa", "web", "worker"]);
    const web = entries.find(
      (entry) => entry.kind === "npm" && entry.phase === "start" && entry.service === "web",
    );
    expect(web).toMatchObject({
      artifactRoot: join(stateRoot, "review-artifacts"),
      databaseUrl: `postgres://kestrel_runtime:kestrel_runtime_dev@127.0.0.1:${String(databasePort)}/kestrel`,
      ghExecutable: join(tools, "gh"),
      gitExecutable: join(tools, "git"),
      hasModelProviderSecretRoot: true,
      hasSessionSigningKey: true,
      host: "127.0.0.1",
      modelProviderSecretRoot: join(stateRoot, "model-provider-secrets"),
      repositoryRootsFile: join(stateRoot, "repository-roots.json"),
      resolvedHostTools: true,
    });
    expect(
      entries
        .filter(
          (entry) =>
            entry.kind === "npm" &&
            entry.phase === "start" &&
            ["build", "pwa", "worker"].includes(String(entry.service)),
        )
        .map((entry) => ({
          hasModelProviderSecretRoot: entry.hasModelProviderSecretRoot,
          hasSessionSigningKey: entry.hasSessionSigningKey,
          service: entry.service,
        }))
        .sort((left, right) => String(left.service).localeCompare(String(right.service))),
    ).toEqual([
      { hasModelProviderSecretRoot: false, hasSessionSigningKey: false, service: "build" },
      { hasModelProviderSecretRoot: false, hasSessionSigningKey: false, service: "pwa" },
      { hasModelProviderSecretRoot: false, hasSessionSigningKey: false, service: "worker" },
    ]);
    expect(output).toContain(`git=${join(tools, "git")}`);
    expect(output).toContain(`gh=${join(tools, "gh")}`);
    expect(output).toContain(`codex=${join(tools, "codex")}`);
    expect(output).not.toContain("npm error");
    expect((await stat(join(stateRoot, "review-artifacts"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(stateRoot, "model-provider-secrets"))).mode & 0o777).toBe(0o700);
  }, 20_000);
});
