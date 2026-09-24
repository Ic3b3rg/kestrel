import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const entry = resolve(process.argv[2]);
const label = basename(process.cwd());
const sourceRoots = [dirname(entry), resolve("../../packages")];
const stopTimeoutMs = 90_000;
let child;
let childStop;
let debounce;
let stopping = false;
let pendingRestart = false;
let restarting;

function start() {
  console.log(`[kestrel] Starting ${label} from source`);
  const next = spawn(process.execPath, ["--import=tsx", "--conditions=development", entry], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "inherit", "inherit"],
  });
  child = next;
  next.once("error", (error) => {
    console.error(`[kestrel] ${label}: ${error.message}`);
    void shutdown(1);
  });
  next.once("close", () => {
    if (child === next) child = undefined;
    if (!stopping) console.log(`[kestrel] ${label} stopped; waiting for source changes`);
  });
}

function signal(target, value) {
  if (target.exitCode !== null || target.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && target.pid !== undefined) process.kill(-target.pid, value);
    else target.kill(value);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function stop() {
  const target = child;
  if (target === undefined) return Promise.resolve();
  if (childStop?.target === target) return childStop.promise;
  const promise = new Promise((resolveStopped) => {
    const timeout = setTimeout(() => signal(target, "SIGKILL"), stopTimeoutMs);
    target.once("close", () => {
      clearTimeout(timeout);
      resolveStopped();
    });
    signal(target, "SIGTERM");
  });
  childStop = { target, promise };
  return promise;
}

async function restart() {
  pendingRestart = true;
  if (restarting !== undefined) return;
  restarting = (async () => {
    while (pendingRestart && !stopping) {
      pendingRestart = false;
      await stop();
      if (!stopping) start();
    }
  })();
  try {
    await restarting;
  } finally {
    restarting = undefined;
  }
}

const watchers = sourceRoots.map((root) =>
  watch(root, { recursive: true }, (_event, filename) => {
    if (stopping || filename === null) return;
    const path = filename.toString().replaceAll("\\", "/");
    if (!/\.(ts|json)$/u.test(path) || path.endsWith(".test.ts")) return;
    if (root === sourceRoots[1] && !/^[^/]+\/src\//u.test(path)) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      void restart().catch((error) => {
        console.error(`[kestrel] ${label}: ${error.message}`);
        void shutdown(1);
      });
    }, 200);
  }),
);

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(debounce);
  for (const watcher of watchers) watcher.close();
  await stop();
  await restarting;
  process.exitCode = code;
}

for (const watcher of watchers) {
  watcher.on("error", (error) => {
    console.error(`[kestrel] ${label}: ${error.message}`);
    void shutdown(1);
  });
}
for (const value of ["SIGINT", "SIGTERM"]) process.on(value, () => void shutdown(0));
start();
