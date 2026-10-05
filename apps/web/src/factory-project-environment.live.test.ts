import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { createCodexExecutionRuntime } from "./codex-execution-runtime.js";

const image = process.env.KESTREL_PREPARED_ENVIRONMENT_TEST_IMAGE;
it.skipIf(image === undefined)(
  "prepares a real Node workspace and contains a private Docker daemon, including teardown",
  async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "kestrel-prepared-live-")));
    const events: string[] = [];
    try {
      await writeFile(join(cwd, ".git"), "gitdir: /controller-owned-live-fixture\n");
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({
          name: "environment-probe",
          version: "1.0.0",
          private: true,
          scripts: { build: 'node -e "setTimeout(()=>{},2000)"' },
        }),
      );
      await writeFile(
        join(cwd, "package-lock.json"),
        JSON.stringify({
          name: "environment-probe",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: { "": { name: "environment-probe", version: "1.0.0" } },
        }),
      );
      const runtime = createCodexExecutionRuntime({
        containerImage: image ?? "",
        projectEnvironment: "node_docker",
        dockerExecutable: process.env.DOCKER_BIN ?? "docker",
        containerResources: {
          memoryBytes: 5.5 * 1024 ** 3,
          pidsLimit: 512,
          nanoCpus: 2_000_000_000,
          tmpfsBytes: 512 * 1024 ** 2,
        },
      });
      const result = await runtime.runVerification({
        workspaceCwd: cwd,
        cwd: ".",
        processId: `prepared-live:${String(Date.now())}`,
        timeoutMs: 1_000,
        beforeContainerCreate: () => {
          events.push("reserved");
          return Promise.resolve();
        },
        onContainer: () => {
          events.push("identified");
          return Promise.resolve();
        },
        onStopped: () => {
          events.push("stopped");
          return Promise.resolve();
        },
        command: [
          "node",
          "-e",
          `const {execFileSync}=require('node:child_process'); const fs=require('node:fs'); console.log(JSON.stringify({docker:JSON.parse(execFileSync('docker',['info','--format','{{json .}}'],{encoding:'utf8'})).ServerVersion,heap:require('node:v8').getHeapStatistics().heap_size_limit,cpus:require('node:os').availableParallelism(),memory:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),pids:fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),chromium:fs.readdirSync('/opt/playwright').some(x=>x.startsWith('chromium-'))}));`,
        ],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const facts = z
        .object({
          heap: z.number(),
          docker: z.string(),
          cpus: z.number(),
          memory: z.string(),
          pids: z.string(),
          chromium: z.boolean(),
        })
        .parse(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}"));
      expect(facts).toMatchObject({
        cpus: 2,
        memory: String(5.5 * 1024 ** 3),
        pids: "512",
        chromium: true,
      });
      expect(facts.heap).toBeGreaterThan(1.5 * 1024 ** 3);
      expect(facts.docker).toMatch(/^\d+\./u);
      expect(events).toEqual(["reserved", "identified", "stopped"]);
      expect(await readFile(join(cwd, "node_modules/.kestrel-environment-v1"), "utf8")).toMatch(
        /^[a-f0-9]{64}$/u,
      );
      await expect(
        runtime.runVerification({
          workspaceCwd: cwd,
          cwd: ".",
          processId: `prepared-timeout:${String(Date.now())}`,
          timeoutMs: 100,
          beforeContainerCreate: () => Promise.resolve(),
          onContainer: () => Promise.resolve(),
          onStopped: () => Promise.resolve(),
          command: ["node", "-e", "setTimeout(()=>{},2000)"],
        }),
      ).resolves.toMatchObject({ exitCode: 124, timedOut: true });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  200_000,
);
