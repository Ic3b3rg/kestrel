import { spawn } from "node:child_process";

import type { FactoryProviderFailure } from "@kestrel/contracts";

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  started: boolean;
  failure?: FactoryProviderFailure;
}

function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GH_HOST: "github.com", LANG: "C", LC_ALL: "C", NO_COLOR: "1" };
  for (const name of ["HOME", "PATH", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"] as const) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

/** The caller classifies write certainty; an interrupted child may already have sent its request. */
export function runFactoryGitHubCli({
  executable,
  args,
  timeoutMs,
  input,
  signal,
}: {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  input?: string;
  signal?: AbortSignal;
}): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ stdout: "", stderr: "", exitCode: null, started: false, failure: "cancelled" });
      return;
    }
    const child = spawn(executable, args, {
      detached: process.platform !== "win32",
      env: environment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let started = child.pid !== undefined;
    let settled = false;
    let failure: FactoryProviderFailure | undefined;
    const kill = () => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          /* direct-child fallback */
        }
      }
      child.kill("SIGKILL");
    };
    const onAbort = () => {
      failure = "cancelled";
      kill();
    };
    const timer = setTimeout(() => {
      failure = "timeout";
      kill();
    }, timeoutMs);
    timer.unref();
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
        exitCode,
        started,
        ...(failure === undefined ? {} : { failure }),
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.once("spawn", () => {
      started = true;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes + chunk.byteLength > 2 * 1024 * 1024) {
        failure = "invalid_response";
        kill();
        return;
      }
      stdout.push(chunk);
      stdoutBytes += chunk.byteLength;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes + chunk.byteLength > 32 * 1024) {
        failure = "invalid_response";
        kill();
        return;
      }
      stderr.push(chunk);
      stderrBytes += chunk.byteLength;
    });
    child.stdin.on("error", () => {
      failure ??= "unavailable";
      kill();
    });
    child.once("error", () => {
      failure = "unavailable";
      finish(null);
    });
    child.once("close", finish);
    child.stdin.end(input ?? "");
  });
}
