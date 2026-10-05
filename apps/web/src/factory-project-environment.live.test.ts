import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import type { FactoryPrivateDockerStorage } from "@kestrel/contracts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createCodexExecutionRuntime,
  createCodexExecutionContainerRecovery,
} from "./codex-execution-runtime.js";

const image = process.env.KESTREL_PREPARED_ENVIRONMENT_TEST_IMAGE;
it.skipIf(image === undefined)(
  "prepares a real Node workspace and contains a private Docker daemon, including teardown",
  async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "kestrel-prepared-live-")));
    const events: string[] = [];
    const storageNames: string[] = [];
    const owned = new Map<
      string,
      {
        name: string;
        id: string | null;
        daemonId?: string;
        privateStorageRequired: true;
        privateStorage?: FactoryPrivateDockerStorage;
      }
    >();
    const reserve = (name: string, daemonId?: string) => {
      owned.set(name, {
        name,
        id: null,
        ...(daemonId === undefined ? {} : { daemonId }),
        privateStorageRequired: true,
      });
      return Promise.resolve();
    };
    const stopped = ({ name }: { name: string }) => {
      owned.delete(name);
      return Promise.resolve();
    };
    const retainStorage = ({
      name,
      id,
      privateStorage,
    }: {
      name: string;
      id: string;
      privateStorage?: FactoryPrivateDockerStorage;
    }) => {
      if (privateStorage === undefined) throw new Error("Private storage receipt missing");
      const intent = owned.get(name);
      if (intent === undefined) throw new Error("Container intent missing");
      owned.set(name, { ...intent, id, privateStorage });
      storageNames.push(privateStorage.name);
      return Promise.resolve();
    };
    try {
      await writeFile(join(cwd, ".git"), "gitdir: /controller-owned-live-fixture\n");
      await writeFile(
        join(cwd, "Dockerfile"),
        "FROM scratch\nCOPY package.json /package.json\nLABEL org.kestrel.fixture.prepared=true\n",
      );
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
        executable: process.execPath,
        arguments: [
          fileURLToPath(new URL("./__fixtures__/codex-execution-runtime.mjs", import.meta.url)),
          "happy",
          join(cwd, "protocol.jsonl"),
        ],
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
        beforeContainerCreate: (name, daemonId) => {
          events.push("reserved");
          return reserve(name, daemonId);
        },
        onContainer: (container) => {
          events.push("identified");
          return retainStorage(container);
        },
        onStopped: (container) => {
          events.push("stopped");
          return stopped(container);
        },
        command: [
          "node",
          "-e",
          `const {execFileSync}=require('node:child_process'); const fs=require('node:fs'); const temp=fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'git-fixture-')); const fixture=require('node:path').join(temp,'git'); let tempExecutable; try { fs.writeFileSync(fixture,${JSON.stringify("#!/bin/sh\necho fixture-ready\n")},{mode:0o700}); tempExecutable=execFileSync(fixture,{encoding:'utf8'}).trim()==='fixture-ready'; } finally {fs.rmSync(temp,{recursive:true,force:true});} console.log(JSON.stringify({tempExecutable,preparedImage:execFileSync('docker',['image','ls','--filter','label=org.kestrel.fixture.prepared=true','--format','{{.ID}}'],{encoding:'utf8'}).trim().length>0,driver:execFileSync('docker',['info','--format','{{.Driver}}'],{encoding:'utf8'}).trim(),docker:JSON.parse(execFileSync('docker',['info','--format','{{json .}}'],{encoding:'utf8'})).ServerVersion,heap:require('node:v8').getHeapStatistics().heap_size_limit,cpus:require('node:os').availableParallelism(),memory:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),pids:fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),chromium:fs.readdirSync('/opt/playwright').some(x=>x.startsWith('chromium-'))}));`,
        ],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("Project container image ready");
      const facts = z
        .object({
          heap: z.number(),
          docker: z.string(),
          driver: z.string(),
          cpus: z.number(),
          memory: z.string(),
          pids: z.string(),
          chromium: z.boolean(),
          tempExecutable: z.boolean(),
          preparedImage: z.boolean(),
        })
        .parse(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}"));
      expect(facts).toMatchObject({
        driver: "overlay2",
        cpus: 2,
        memory: String(5.5 * 1024 ** 3),
        pids: "512",
        chromium: true,
        tempExecutable: true,
        preparedImage: true,
      });
      expect(facts.heap).toBeGreaterThan(1.5 * 1024 ** 3);
      expect(facts.docker).toMatch(/^\d+\./u);
      expect(events).toEqual(["reserved", "identified", "stopped"]);
      const nestedDocker = await runtime.runVerification({
        workspaceCwd: cwd,
        cwd: ".",
        processId: `prepared-docker:${String(Date.now())}`,
        timeoutMs: 60_000,
        beforeContainerCreate: reserve,
        onContainer: retainStorage,
        onStopped: stopped,
        command: [
          "node",
          "-e",
          `const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const context=fs.mkdtempSync('/tmp/docker-workload-'); const tag='kestrel-live-workload'; let built=false; try { fs.copyFileSync('/usr/local/bin/docker',context+'/docker'); fs.writeFileSync(context+'/Dockerfile',${JSON.stringify('FROM scratch\nCOPY docker /docker\nRUN ["/docker", "--version"]\nENTRYPOINT ["/docker", "--version"]\n')}); execFileSync('docker',['build','--network=none','-t',tag,context],{stdio:'inherit'}); built=true; const output=execFileSync('docker',['run','--rm','--network=none',tag],{encoding:'utf8'}); if(!output.startsWith('Docker version '))throw new Error(output); console.log('Nested Docker workload ready'); } finally { if(built)execFileSync('docker',['image','rm','--force',tag],{stdio:'inherit'}); fs.rmSync(context,{recursive:true,force:true}); }`,
        ],
      });
      expect(nestedDocker.exitCode, nestedDocker.stderr).toBe(0);
      expect(nestedDocker.stdout).toContain("Nested Docker workload ready");
      expect(await readFile(join(cwd, "node_modules/.kestrel-environment-v1"), "utf8")).toMatch(
        /^[a-f0-9]{64}$/u,
      );
      await expect(
        runtime.runVerification({
          workspaceCwd: cwd,
          cwd: ".",
          processId: `prepared-timeout:${String(Date.now())}`,
          timeoutMs: 100,
          beforeContainerCreate: reserve,
          onContainer: retainStorage,
          onStopped: stopped,
          command: ["node", "-e", "setTimeout(()=>{},2000)"],
        }),
      ).resolves.toMatchObject({ exitCode: 124, timedOut: true });
      // A source regression is the agent's job to repair, not an unusable toolchain.
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({
          name: "environment-probe",
          version: "1.0.0",
          private: true,
          scripts: {
            build: "node -e \"require('node:fs').writeSync(2,'x'.repeat(100000));process.exit(9)\"",
          },
        }),
      );
      await writeFile(join(cwd, "Dockerfile"), "FROM scratch\nCOPY missing-file /missing-file\n");
      const onTurn = vi.fn(() => Promise.resolve());
      const onQuestion = vi.fn(() => Promise.resolve());
      const repairedTurn = await runtime.runTurn({
        cwd,
        model: "fixture-model",
        requestId: `prepared-repair:${String(Date.now())}`,
        prompt: "Repair the broken project build within the approved scope.",
        beforeContainerCreate: reserve,
        onContainer: retainStorage,
        onStopped: stopped,
        onThread: () => Promise.resolve(),
        onTurn,
        onActivity: () => Promise.resolve(),
        onQuestion,
      });
      expect(repairedTurn.text).toBe("Implemented. 🪶");
      expect(onTurn).toHaveBeenCalled();
      expect(onQuestion).not.toHaveBeenCalled();
      const preparation = await runtime.runVerification({
        workspaceCwd: cwd,
        cwd: ".",
        processId: `prepared-warnings:${String(Date.now())}`,
        timeoutMs: 1_000,
        retainStderrTail: true,
        beforeContainerCreate: reserve,
        onContainer: retainStorage,
        onStopped: stopped,
        command: ["true"],
      });
      expect(preparation.exitCode).toBe(0);
      expect(preparation.stderrTruncated).toBe(true);
      expect(Buffer.byteLength(preparation.stderr)).toBeLessThanOrEqual(64 * 1024);
      expect(preparation.stderr).toContain(
        "Project source warm-up failures: npm (exit 9); docker (exit 1)",
      );
      const failedCheck = await runtime.runVerification({
        workspaceCwd: cwd,
        cwd: ".",
        processId: `prepared-failed-check:${String(Date.now())}`,
        timeoutMs: 1_000,
        beforeContainerCreate: reserve,
        onContainer: retainStorage,
        onStopped: stopped,
        command: ["node", "-e", "console.log('Original check executed'); process.exit(7)"],
      });
      expect(failedCheck.exitCode).toBe(7);
      expect(failedCheck.timedOut).not.toBe(true);
      expect(failedCheck.stdout).toContain("Docker build and workload ready");
      expect(failedCheck.stdout).toContain("Original check executed");
      expect(failedCheck.stderrTruncated).toBe(true);
      expect(storageNames).toHaveLength(6);
      for (const name of storageNames) {
        const result = await promisify(execFile)(
          process.env.DOCKER_BIN ?? "docker",
          ["volume", "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"],
          { timeout: 5000 },
        );
        expect(result.stdout.trim()).toBe("");
      }
    } finally {
      const recover = createCodexExecutionContainerRecovery({
        dockerExecutable: process.env.DOCKER_BIN ?? "docker",
      });
      for (const container of owned.values()) {
        await recover(
          { ...container, image: image ?? null },
          (id, privateStorage) => {
            owned.set(container.name, {
              ...container,
              id,
              ...(privateStorage === undefined ? {} : { privateStorage }),
            });
            return Promise.resolve();
          },
          AbortSignal.timeout(10_000),
        );
        owned.delete(container.name);
      }
      await rm(cwd, { recursive: true, force: true });
    }
  },
  200_000,
);
