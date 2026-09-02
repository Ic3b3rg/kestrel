import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  environmentForDocker,
  findExecutable,
  requireExecutable,
  resolveDocker,
} from "./host-executables.mjs";

const LOOPBACK = "127.0.0.1";
const DEFAULT_DATABASE_PORT = 54_320;
const DEFAULT_WEB_PORT = 3_000;
const DEFAULT_PWA_PORT = 5_173;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const PROCESS_STOP_TIMEOUT_MS = 5_000;

function readPositiveInteger(environment, key, defaultValue, maximum = 65_535) {
  const value = environment[key] ?? String(defaultValue);
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${key} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${key} must be at most ${String(maximum)}`);
  }
  return parsed;
}

async function ensurePrivateDirectory(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`${path} must be a non-symlink directory`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await mkdir(path, { mode: 0o700, recursive: true });
    } else {
      throw error;
    }
  }
  await chmod(path, 0o700);
  const canonical = await realpath(path);
  const metadata = await stat(canonical);
  if (process.getuid !== undefined && metadata.uid !== process.getuid()) {
    throw new Error(`${path} must be owned by the current Operator`);
  }
  return canonical;
}

async function readOrCreateSessionSigningKey(stateRoot) {
  const path = join(stateRoot, "session-signing-key");
  const readExisting = async () => {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("The development session signing key must be a non-symlink file");
    }
    await chmod(path, 0o600);
    const value = (await readFile(path, "utf8")).trim();
    if (value.length < 32) throw new Error("The development session signing key is invalid");
    return value;
  };

  try {
    return await readExisting();
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  const generated = randomBytes(32).toString("base64url");
  try {
    await writeFile(path, `${generated}\n`, { flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    return readExisting();
  }
}

function run(command, args, environment) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env: environment,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with ${String(code ?? signal)}`));
    });
  });
}

function startHostProcess(command, args, environment) {
  return spawn(command, args, {
    detached: process.platform !== "win32",
    env: environment,
    shell: false,
    stdio: "inherit",
  });
}

function startObservedHostProcess(command, args, environment) {
  let output = "";
  const child = spawn(command, args, {
    detached: process.platform !== "win32",
    env: environment,
    shell: false,
    stdio: ["inherit", "pipe", "pipe"],
  });
  const forward = (stream, destination) => {
    stream.on("data", (chunk) => {
      destination.write(chunk);
      output = `${output}${chunk.toString("utf8")}`.slice(-8_192);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  return { child, readOutput: () => output };
}

function signalHostProcess(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group may already have stopped; fall back to the direct child.
    }
  }
  child.kill(signal);
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => child.once("close", () => resolvePromise()));
}

async function stopHostProcesses(children) {
  const closed = children.map(waitForClose);
  for (const child of children) signalHostProcess(child, "SIGTERM");
  let timeout;
  const stopped = await Promise.race([
    Promise.all(closed).then(() => true),
    new Promise((resolvePromise) => {
      timeout = setTimeout(() => resolvePromise(false), PROCESS_STOP_TIMEOUT_MS);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (!stopped) {
    for (const child of children) signalHostProcess(child, "SIGKILL");
    await Promise.all(closed);
  }
}

async function waitForHttp(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Host process stopped before ${url} became ready`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      // The host process is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForProcessOutput(observed, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (observed.readOutput().includes(expected)) return;
    if (observed.child.exitCode !== null || observed.child.signalCode !== null) {
      throw new Error(`Host process stopped before reporting ${expected}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for host process output ${expected}`);
}

async function main() {
  const environment = process.env;
  const action = process.argv[2] ?? "start";
  const actionArgument = process.argv[3];
  const validAction = ["start", "bootstrap", "reset-password"].includes(action)
    ? actionArgument === undefined && process.argv.length <= 3
    : action === "authorize-repository-root" &&
      actionArgument !== undefined &&
      process.argv.length === 4;
  if (!validAction) {
    throw new Error(
      "Usage: local-development.mjs [start|bootstrap|reset-password|authorize-repository-root <absolute-path>]",
    );
  }
  const databasePort = readPositiveInteger(
    environment,
    "KESTREL_DATABASE_PORT",
    DEFAULT_DATABASE_PORT,
  );
  const webPort = readPositiveInteger(environment, "KESTREL_WEB_PORT", DEFAULT_WEB_PORT);
  const pwaPort = readPositiveInteger(environment, "KESTREL_PWA_PORT", DEFAULT_PWA_PORT);
  const startupTimeoutMs = readPositiveInteger(
    environment,
    "KESTREL_STARTUP_TIMEOUT_MS",
    DEFAULT_STARTUP_TIMEOUT_MS,
    300_000,
  );
  const configuredStateRoot = environment.KESTREL_STATE_ROOT ?? resolve(".kestrel/development");
  if (!isAbsolute(configuredStateRoot)) throw new Error("KESTREL_STATE_ROOT must be absolute");

  const [npm, git, gh, codex] = await Promise.all([
    requireExecutable("npm", "npm", environment),
    requireExecutable("git", environment.LOCAL_GIT_EXECUTABLE ?? "git", environment),
    findExecutable("gh", environment),
    findExecutable("codex", environment),
  ]);
  const stateRoot = await ensurePrivateDirectory(configuredStateRoot);
  const artifactRoot = await ensurePrivateDirectory(join(stateRoot, "review-artifacts"));
  const modelProviderSecretRoot = await ensurePrivateDirectory(
    join(stateRoot, "model-provider-secrets"),
  );
  const repositoryRootsConfiguration = join(stateRoot, "repository-roots.json");
  const sessionSigningKey = await readOrCreateSessionSigningKey(stateRoot);
  const databasePassword = environment.KESTREL_RUNTIME_DATABASE_PASSWORD ?? "kestrel_runtime_dev";
  const databaseUrl = `postgres://kestrel_runtime:${encodeURIComponent(databasePassword)}@${LOOPBACK}:${String(databasePort)}/kestrel`;
  const hostEnvironment = { ...environment };
  for (const key of [
    "ARTIFACT_ROOT",
    "DATABASE_URL",
    "EVENT_RETENTION_LIMIT",
    "HOST",
    "KESTREL_CODEX_EXECUTABLE",
    "KESTREL_GH_EXECUTABLE",
    "LOCAL_GIT_EXECUTABLE",
    "LOCAL_REPOSITORY_ROOTS",
    "LOCAL_REPOSITORY_ROOTS_FILE",
    "MODEL_PROVIDER_SECRET_ROOT",
    "PORT",
    "REVIEW_REVISION_MAX_BYTES",
    "REVIEW_REVISION_MAX_OBJECTS",
    "SESSION_SIGNING_KEY",
    "VITE_API_PROXY",
  ]) {
    delete hostEnvironment[key];
  }
  const serverEnvironment = {
    ...hostEnvironment,
    DATABASE_URL: databaseUrl,
    EVENT_RETENTION_LIMIT: environment.EVENT_RETENTION_LIMIT ?? "1000",
  };
  const localRepositoryEnvironment =
    environment.LOCAL_REPOSITORY_ROOTS === undefined
      ? { LOCAL_REPOSITORY_ROOTS_FILE: repositoryRootsConfiguration }
      : { LOCAL_REPOSITORY_ROOTS: environment.LOCAL_REPOSITORY_ROOTS };
  const webEnvironment = {
    ...serverEnvironment,
    ARTIFACT_ROOT: artifactRoot,
    ...(codex === null ? {} : { KESTREL_CODEX_EXECUTABLE: codex }),
    HOST: LOOPBACK,
    ...(gh === null ? {} : { KESTREL_GH_EXECUTABLE: gh }),
    LOCAL_GIT_EXECUTABLE: git,
    ...localRepositoryEnvironment,
    MODEL_PROVIDER_SECRET_ROOT: modelProviderSecretRoot,
    PORT: String(webPort),
    REVIEW_REVISION_MAX_BYTES: environment.REVIEW_REVISION_MAX_BYTES ?? "268435456",
    REVIEW_REVISION_MAX_OBJECTS: environment.REVIEW_REVISION_MAX_OBJECTS ?? "200000",
    SESSION_SIGNING_KEY: sessionSigningKey,
  };

  console.log(
    `[kestrel] Host tools: git=${git} gh=${gh ?? "unavailable"} codex=${codex ?? "unavailable"}`,
  );
  if (action === "authorize-repository-root") {
    const authorizationEnvironment = { ...webEnvironment };
    delete authorizationEnvironment.LOCAL_REPOSITORY_ROOTS;
    authorizationEnvironment.LOCAL_REPOSITORY_ROOTS_FILE = repositoryRootsConfiguration;
    await run(
      process.execPath,
      ["--import=tsx", "scripts/authorize-repository-root.ts", actionArgument],
      authorizationEnvironment,
    );
    return;
  }
  if (action !== "start") {
    await run(npm, ["run", action, "-w", "@kestrel/web"], webEnvironment);
    return;
  }

  const docker = await resolveDocker(environment);
  const compose = ["compose", "-f", "compose.yaml", "-f", "compose.local.yaml"];
  const dockerEnvironment = {
    ...environmentForDocker(docker, environment),
    KESTREL_ARTIFACT_ROOT: artifactRoot,
    KESTREL_MODEL_PROVIDER_SECRET_ROOT: modelProviderSecretRoot,
    SESSION_SIGNING_KEY: sessionSigningKey,
  };
  console.log("[kestrel] Preparing PostgreSQL and database state...");
  await run(
    docker,
    [...compose, "rm", "--stop", "--force", "web", "worker", "pwa"],
    dockerEnvironment,
  );
  await run(docker, [...compose, "build", "migrate"], dockerEnvironment);
  await run(docker, [...compose, "up", "--detach", "--wait", "postgres"], dockerEnvironment);
  await run(docker, [...compose, "run", "--rm", "--no-deps", "migrate"], dockerEnvironment);
  await run(docker, [...compose, "run", "--rm", "--no-deps", "database-role"], dockerEnvironment);
  await run(
    docker,
    [...compose, "run", "--rm", "--no-deps", "legacy-state-import"],
    dockerEnvironment,
  );
  await Promise.all([
    ensurePrivateDirectory(artifactRoot),
    ensurePrivateDirectory(modelProviderSecretRoot),
  ]);
  console.log("[kestrel] Building host applications...");
  await run(npm, ["run", "build"], hostEnvironment);

  const worker = startObservedHostProcess(
    npm,
    ["--silent", "run", "start", "-w", "@kestrel/worker"],
    serverEnvironment,
  );
  const children = [
    startHostProcess(npm, ["--silent", "run", "start", "-w", "@kestrel/web"], webEnvironment),
    worker.child,
    startHostProcess(
      npm,
      [
        "--silent",
        "run",
        "dev",
        "-w",
        "@kestrel/pwa",
        "--",
        "--host",
        LOOPBACK,
        "--port",
        String(pwaPort),
      ],
      { ...hostEnvironment, VITE_API_PROXY: `http://${LOOPBACK}:${String(webPort)}` },
    ),
  ];
  let shuttingDown = false;
  let exitCode = 0;
  let resolveShutdown;
  const shutdownComplete = new Promise((resolvePromise) => {
    resolveShutdown = resolvePromise;
  });
  const shutdown = async (reason, requestedExitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;
    exitCode = requestedExitCode;
    console.log(`[kestrel] Stopping host processes (${reason})...`);
    await stopHostProcesses(children);
    resolveShutdown();
  };
  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  for (const child of children) {
    child.once("error", (error) => {
      console.error(`[kestrel] Host process failed: ${error.message}`);
      void shutdown("process error", 1);
    });
    child.once("close", (code, signal) => {
      if (!shuttingDown) {
        console.error(`[kestrel] Host process exited unexpectedly: ${String(code ?? signal)}`);
        void shutdown("unexpected process exit", 1);
      }
    });
  }

  try {
    await Promise.all([
      waitForHttp(
        `http://${LOOPBACK}:${String(webPort)}/health/ready`,
        children[0],
        startupTimeoutMs,
      ),
      waitForHttp(`http://${LOOPBACK}:${String(pwaPort)}`, children[2], startupTimeoutMs),
      waitForProcessOutput(worker, '"event":"worker.started"', startupTimeoutMs),
    ]);
    if (!shuttingDown) {
      console.log(
        `[kestrel] Kestrel is ready: PWA http://${LOOPBACK}:${String(pwaPort)} API http://${LOOPBACK}:${String(webPort)}`,
      );
      console.log("[kestrel] Press Ctrl-C to stop the host processes.");
    }
  } catch (error) {
    console.error(
      `[kestrel] Startup failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    await shutdown("startup failure", 1);
  }

  await shutdownComplete;
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(`[kestrel] ${error instanceof Error ? error.message : "Local startup failed"}`);
  process.exitCode = 1;
});
