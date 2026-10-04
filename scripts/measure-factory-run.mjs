#!/usr/bin/env node
import { execFile } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const [output, runtimePidText] = process.argv.slice(2);
const runtimePid = Number(runtimePidText);
if (!output || !Number.isSafeInteger(runtimePid) || runtimePid <= 0) {
  console.error("Usage: node scripts/measure-factory-run.mjs OUTPUT.jsonl RUNTIME_PID");
  process.exit(2);
}

const docker = "/Applications/Docker.app/Contents/Resources/bin/docker";
const command = async (file, args) => {
  try {
    return (await execFileAsync(file, args, { timeout: 10_000, maxBuffer: 2_000_000 })).stdout;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

function processMemory(output) {
  if (typeof output !== "string") return output;
  const rows = output
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
      return (
        match && {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          rssKiB: Number(match[3]),
          command: match[4],
        }
      );
    })
    .filter(Boolean);
  const descendants = new Set([runtimePid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  const runtime = rows.filter((row) => descendants.has(row.pid));
  const dockerBackend = rows.filter((row) => row.command.includes("com.docker.backend"));
  return {
    runtimeRssKiB: runtime.reduce((sum, row) => sum + row.rssKiB, 0),
    runtimeProcesses: runtime,
    dockerBackendRssKiB: dockerBackend.reduce((sum, row) => sum + row.rssKiB, 0),
  };
}

const dockerInfo = await command(docker, ["info", "--format", "{{.MemTotal}} {{.NCPU}}"]);
await writeFile(
  output,
  `${JSON.stringify({ kind: "start", at: new Date().toISOString(), runtimePid, dockerInfo })}\n`,
);
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});
while (!stopping) {
  const at = new Date().toISOString();
  const [vmStat, pressure, processes, stats] = await Promise.all([
    command("vm_stat", []),
    command("memory_pressure", ["-Q"]),
    command("ps", ["-axo", "pid,ppid,rss,comm"]),
    command(docker, ["stats", "--no-stream", "--format", "{{json .}}"]),
  ]);
  const factoryNames =
    typeof stats === "string"
      ? stats
          .trim()
          .split("\n")
          .flatMap((line) => {
            try {
              const name = JSON.parse(line).Name;
              return typeof name === "string" && name.startsWith("kestrel-factory-") ? [name] : [];
            } catch {
              return [];
            }
          })
      : [];
  const cgroups = await Promise.all(
    factoryNames.map(async (name) => {
      const [memory, pids] = await Promise.all([
        command(docker, [
          "exec",
          name,
          "sh",
          "-c",
          "cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.events",
        ]),
        command(docker, [
          "exec",
          name,
          "sh",
          "-c",
          "cat /sys/fs/cgroup/pids.current /sys/fs/cgroup/pids.peak /sys/fs/cgroup/pids.max /sys/fs/cgroup/pids.events",
        ]),
      ]);
      return { name, memory, pids };
    }),
  );
  await appendFile(
    output,
    `${JSON.stringify({ kind: "sample", at, vmStat, pressure, processes: processMemory(processes), stats, cgroups })}\n`,
  );
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}
await appendFile(output, `${JSON.stringify({ kind: "stop", at: new Date().toISOString() })}\n`);
