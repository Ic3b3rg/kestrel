import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
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

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", resolvePromise);
  });
}

afterEach(async () => {
  for (const child of runningChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("supported local development lifecycle", () => {
  it("runs only database preparation in Compose and supervises loopback host processes", async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), "kestrel-local-development-")));
    temporaryDirectories.push(fixture);
    const tools = join(fixture, "tools");
    const stateRoot = join(fixture, "state");
    const logPath = join(fixture, "lifecycle.jsonl");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(tools));

    const recorder = `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.KESTREL_LIFECYCLE_TEST_LOG, JSON.stringify({
  args: process.argv.slice(2),
  kind: "docker"
}) + "\\n");
`;
    await writeExecutable(join(tools, "docker"), `#!/usr/bin/env node\n${recorder}`);

    const hostProcess = `#!/usr/bin/env node
import { appendFileSync, constants, accessSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);
const workspaceIndex = args.indexOf("-w");
const workspace = workspaceIndex === -1 ? "build" : args[workspaceIndex + 1];
const service = workspace === "@kestrel/web" ? "web" :
  workspace === "@kestrel/worker" ? "worker" :
  workspace === "@kestrel/pwa" ? "pwa" : "build";
const record = (phase, signal) => appendFileSync(
  process.env.KESTREL_LIFECYCLE_TEST_LOG,
  JSON.stringify({
    args,
    artifactRoot: process.env.ARTIFACT_ROOT,
    databaseUrl: process.env.DATABASE_URL,
    gitExecutable: process.env.LOCAL_GIT_EXECUTABLE,
    hasSessionSigningKey: Boolean(process.env.SESSION_SIGNING_KEY),
    host: process.env.HOST,
    kind: "npm",
    modelProviderSecretRoot: process.env.MODEL_PROVIDER_SECRET_ROOT,
    phase,
    service,
    signal
  }) + "\\n"
);
record("start");
if (service === "build") process.exit(0);
accessSync(process.env.LOCAL_GIT_EXECUTABLE, constants.X_OK);

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
    const child = spawn(process.execPath, ["scripts/local-development.mjs"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        DOCKER_BIN: join(tools, "docker"),
        KESTREL_DATABASE_PORT: String(databasePort),
        KESTREL_LIFECYCLE_TEST_LOG: logPath,
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
    child.kill("SIGINT");
    await expect(waitForExit(child)).resolves.toBe(0);

    const entries = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.find((entry) => entry.kind === "docker")?.args).toEqual([
      "compose",
      "-f",
      "compose.yaml",
      "-f",
      "compose.local.yaml",
      "up",
      "--build",
      "--detach",
      "--wait",
      "postgres",
      "migrate",
      "database-role",
    ]);
    const startedServices = entries
      .filter((entry) => entry.kind === "npm" && entry.phase === "start")
      .map((entry) => entry.service);
    expect(startedServices[0]).toBe("build");
    expect(startedServices.slice(1).sort()).toEqual(["pwa", "web", "worker"]);
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
      gitExecutable: join(tools, "git"),
      hasSessionSigningKey: true,
      host: "127.0.0.1",
      modelProviderSecretRoot: join(stateRoot, "model-provider-secrets"),
    });
    expect(output).toContain(`git=${join(tools, "git")}`);
    expect(output).toContain(`gh=${join(tools, "gh")}`);
    expect(output).toContain(`codex=${join(tools, "codex")}`);
    expect((await stat(join(stateRoot, "review-artifacts"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(stateRoot, "model-provider-secrets"))).mode & 0o777).toBe(0o700);
  });
});
