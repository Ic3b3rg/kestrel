import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createCodexAppServerAgentRuntime } from "./codex-app-server.js";
import {
  createCodexExecutionRuntime,
  type CodexExecutionLifecycle,
} from "./codex-execution-runtime.js";

const exec = promisify(execFile);

describe.runIf(process.env.KESTREL_LIVE_CODEX_EXECUTION === "1")(
  "Codex execution live conformance",
  () => {
    it("implements a real change, checks it with node --test, and removes all container writers", async () => {
      const image = process.env.KESTREL_FACTORY_EXECUTION_IMAGE;
      if (image === undefined)
        throw new Error("Set KESTREL_FACTORY_EXECUTION_IMAGE to the prepared immutable image ID");
      const docker =
        process.env.KESTREL_DOCKER_EXECUTABLE ??
        (process.platform === "darwin"
          ? "/Applications/Docker.app/Contents/Resources/bin/docker"
          : "docker");
      const { stdout } = await exec("/usr/bin/which", ["codex"], {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 1024,
      });
      const executable = await realpath(process.env.KESTREL_CODEX_EXECUTABLE ?? stdout.trim());
      const connection = await createCodexAppServerAgentRuntime({ executable }).readConnection();
      expect(connection.state).toBe("ready");
      expect(connection.account?.authentication).toBe("chatgpt");
      const model = connection.models.find((candidate) => candidate.isDefault)?.id;
      if (model === undefined) throw new Error("No available default ChatGPT model");

      const root = await realpath(await mkdtemp(join(tmpdir(), "kestrel-live-execution-")));
      const cwd = join(root, "workspace");
      const gitDirectory = join(root, "repository.git");
      const events: { kind: string; name?: string; id?: string | null }[] = [];
      const names: string[] = [];
      const sockets = createServer((socket) => socket.end());
      await new Promise<void>((resolve) => sockets.listen(0, "127.0.0.1", resolve));
      const address = sockets.address();
      if (address === null || typeof address === "string") throw new Error("No canary listener");
      const lifecycle: CodexExecutionLifecycle = {
        beforeContainerCreate: async (name) => {
          names.push(name);
          events.push({ kind: "intent", name });
          await writeFile(join(root, "lifecycle.json"), JSON.stringify(events));
        },
        onContainer: async ({ name, id }) => {
          events.push({ kind: "container", name, id });
          await writeFile(join(root, "lifecycle.json"), JSON.stringify(events));
        },
        onStopped: async ({ name, id }) => {
          events.push({ kind: "stopped", name, id });
          await writeFile(join(root, "lifecycle.json"), JSON.stringify(events));
        },
      };
      try {
        await mkdir(cwd);
        await exec(
          "git",
          ["init", "--initial-branch=main", "--separate-git-dir", gitDirectory, cwd],
          { timeout: 5_000, maxBuffer: 4096 },
        );
        await writeFile(join(cwd, "value.mjs"), "export const value = 1;\n");
        await writeFile(join(root, "outside-canary"), "unchanged");
        await symlink(join(root, "outside-canary"), join(cwd, "escape"));
        const marker = await readFile(join(cwd, ".git"), "utf8");
        const head = await readFile(join(gitDirectory, "HEAD"), "utf8");
        const checks = `import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {value} from './value.mjs';
test('approved behavior',()=>assert.equal(value,2));
test('writable workspace with read-only Git and inaccessible host canaries',()=>{
  fs.writeFileSync('inside-canary','allowed');
  for(const path of [${JSON.stringify(join(root, "outside-canary"))},'escape','.git','/kestrel-git/HEAD'])assert.throws(()=>fs.writeFileSync(path,'changed'));
  assert.throws(()=>fs.readFileSync(${JSON.stringify(join(root, "outside-canary"))}));
});
test('no network to owned host listener',async()=>{
  const connected=await new Promise(resolve=>{const socket=net.connect(${String(address.port)},'host.docker.internal');socket.setTimeout(1000);socket.on('connect',()=>{resolve(true);socket.destroy()});socket.on('error',()=>resolve(false));socket.on('timeout',()=>{resolve(false);socket.destroy()});});
  assert.equal(connected,false);
});
test('detached writer exists before namespace shutdown',async()=>{
  const child=spawn(process.execPath,['-e',"const fs=require('node:fs');setInterval(()=>fs.writeFileSync('/workspace/heartbeat',String(Date.now())),25)"],{detached:true,stdio:'ignore'});child.unref();
  for(let i=0;i<100&&!fs.existsSync('heartbeat');i++)await delay(20);
  const before=fs.readFileSync('heartbeat','utf8');await delay(100);assert.notEqual(fs.readFileSync('heartbeat','utf8'),before);
});\n`;
        await writeFile(join(cwd, "checks.test.mjs"), checks);
        const runtime = createCodexExecutionRuntime({
          executable,
          dockerExecutable: docker,
          containerImage: image,
          timeoutMs: 60_000,
        });
        const turn = await runtime.runTurn({
          ...lifecycle,
          cwd,
          gitDirectory,
          model,
          requestId: randomUUID(),
          prompt:
            "This is a disposable integration fixture. Change only /workspace/value.mjs from export const value = 1; to export const value = 2;. Use the file editing tool. Do not run tests or modify another file. Finish with one concise sentence.",
          onThread: () => Promise.resolve(),
          onTurn: () => Promise.resolve(),
          onActivity: () => Promise.resolve(),
          onQuestion: () => Promise.reject(new Error("Unexpected runtime question")),
        });
        expect(turn.text.trim().length).toBeGreaterThan(0);
        expect(Buffer.byteLength(turn.text)).toBeLessThanOrEqual(128 * 1024);
        expect(events.at(-1)?.kind).toBe("stopped");
        expect(await readFile(join(cwd, "value.mjs"), "utf8")).toContain("value = 2");
        const result = await runtime.runVerification({
          ...lifecycle,
          workspaceCwd: cwd,
          gitDirectory,
          cwd: ".",
          command: ["node", "--test", "checks.test.mjs"],
          processId: randomUUID(),
          timeoutMs: 30_000,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("pass 4");
        expect(result.stdoutTruncated).toBe(false);
        expect(events.filter((event) => event.kind === "stopped")).toHaveLength(2);
        expect(new Set(names).size).toBe(2);
        const heartbeat = await readFile(join(cwd, "heartbeat"), "utf8");
        await delay(150);
        expect(await readFile(join(cwd, "heartbeat"), "utf8")).toBe(heartbeat);
        expect(await readFile(join(root, "outside-canary"), "utf8")).toBe("unchanged");
        expect(await readFile(join(cwd, ".git"), "utf8")).toBe(marker);
        expect(await readFile(join(gitDirectory, "HEAD"), "utf8")).toBe(head);
        expect(await readFile(join(cwd, "checks.test.mjs"), "utf8")).toBe(checks);
      } finally {
        for (const name of names)
          await exec(docker, ["rm", "--force", name], { timeout: 10_000, maxBuffer: 4096 }).catch(
            () => undefined,
          );
        await new Promise<void>((resolve) => sockets.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
