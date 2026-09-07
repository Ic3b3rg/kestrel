import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { createCodexExecutionRuntime } from "./codex-execution-runtime.js";

const directories: string[] = [];
const fixturePath = fileURLToPath(
  new URL("./__fixtures__/codex-execution-runtime.mjs", import.meta.url),
);
const dockerFixturePath = fileURLToPath(
  new URL("./__fixtures__/codex-execution-docker.mjs", import.meta.url),
);

async function fixture(mode = "happy") {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "kestrel-execution-runtime-")));
  directories.push(cwd);
  await writeFile(join(cwd, ".git"), "gitdir: /controller-owned-fixture\n");
  const logPath = join(cwd, "protocol.jsonl");
  const dockerPath = join(cwd, "docker.mjs");
  await writeFile(
    dockerPath,
    `#!${process.execPath}\nprocess.env.KESTREL_TEST_ROOT=${JSON.stringify(cwd)};process.env.KESTREL_TEST_MODE=${JSON.stringify(mode)};await import(${JSON.stringify(dockerFixturePath)});\n`,
    { mode: 0o700 },
  );
  return {
    cwd,
    logPath,
    runtime: createCodexExecutionRuntime({
      executable: process.execPath,
      arguments: [fixturePath, mode, logPath],
      dockerExecutable: dockerPath,
      containerImage: `sha256:${"1".repeat(64)}`,
      timeoutMs: 10_000,
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

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

it("persists container intent before creation and stops the isolated writer before returning its completed turn", async () => {
  const { cwd, logPath, runtime } = await fixture();
  const lifecycle: string[] = [];
  const result = await runtime.runTurn({
    cwd,
    model: "fixture-model",
    requestId: "a74156de-fbd7-4268-90e3-c5b721348393",
    prompt: "Implement the approved feature.",
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
      sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" },
      environments: [
        { environmentId: "remote", cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
      ],
    },
  });
  expect(
    recorded.some(
      (entry) => entry.method === "command/exec" || entry.method === "thread/shellCommand",
    ),
  ).toBe(false);
});
