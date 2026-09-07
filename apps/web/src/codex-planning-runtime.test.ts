import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createCodexPlanningRuntime } from "./codex-planning-runtime.js";

const directories: string[] = [];
const fixturePath = fileURLToPath(
  new URL("./__fixtures__/codex-planning-runtime.mjs", import.meta.url),
);

async function fixture(mode = "happy", timeoutMs = 5_000) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "kestrel-planning-runtime-")));
  directories.push(cwd);
  const logPath = join(cwd, "protocol.jsonl");
  return {
    cwd,
    logPath,
    runtime: createCodexPlanningRuntime({
      executable: process.execPath,
      arguments: [fixturePath, mode, logPath],
      timeoutMs,
    }),
  };
}

async function messages(path: string) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Codex planning runtime", () => {
  it("refuses a host configuration that changes the selected provider", async () => {
    const { cwd, logPath, runtime } = await fixture("wrong_provider");
    await expect(
      runtime.runTurn({
        cwd,
        model: "gpt-5.6-sol",
        prompt: "Clarify the feature.",
        requestId: "provider-1",
        onThread: async () => {},
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect((await messages(logPath)).some((message) => message.method === "turn/start")).toBe(
      false,
    );
  });
  it.each(["unsafe_tools", "unsafe_workspace", "unsafe_network"])(
    "does not persist or start a thread with %s authority",
    async (mode) => {
      const { cwd, logPath, runtime } = await fixture(mode);
      const onThread = vi.fn(async () => {});
      await expect(
        runtime.runTurn({
          cwd,
          model: "gpt-5.6-sol",
          prompt: "Clarify the feature.",
          requestId: "unsafe-1",
          onThread,
        }),
      ).rejects.toMatchObject({ code: "permission_required" });
      expect(onThread).not.toHaveBeenCalled();
      const recorded = await messages(logPath);
      expect(recorded.some((message) => message.method === "turn/start")).toBe(false);
      expect(recorded.at(-1)).toMatchObject({ cleanedUp: true });
    },
  );

  it.each([
    ["authentication", "authentication"],
    ["usage_limit", "usage_limit"],
    ["failed_after_answer", "usage_limit"],
    ["malformed", "invalid_response"],
    ["oversize", "invalid_response"],
    ["only_delta", "invalid_response"],
    ["wrong_turn", "invalid_response"],
    ["tool", "permission_required"],
    ["exit", "interrupted"],
  ])("rejects %s without publishing partial output or raw provider errors", async (mode, code) => {
    const { cwd, runtime } = await fixture(mode);
    await expect(
      runtime.runTurn({
        cwd,
        model: "gpt-5.6-sol",
        prompt: "Clarify the feature.",
        requestId: "failed-1",
        onThread: async () => {},
      }),
    ).rejects.toMatchObject({
      code,
      message: `Codex planning failed: ${code}`,
      question: undefined,
    });
  });

  it("declines unexpected permissions and interrupts the turn", async () => {
    const { cwd, logPath, runtime } = await fixture("permission_required");
    await expect(
      runtime.runTurn({
        cwd,
        model: "gpt-5.6-sol",
        prompt: "Clarify the feature.",
        requestId: "permission-1",
        onThread: async () => {},
      }),
    ).rejects.toMatchObject({ code: "permission_required" });
    const recorded = await messages(logPath);
    expect(recorded.find((message) => message.id === "permission-1")).toMatchObject({
      result: { permissions: {}, scope: "turn" },
    });
    expect(recorded.some((message) => message.method === "turn/interrupt")).toBe(true);
    expect(recorded.at(-1)).toMatchObject({ cleanedUp: true });
  });

  it("resumes the saved thread under the same bounded policy", async () => {
    const { cwd, logPath, runtime } = await fixture();
    await expect(
      runtime.runTurn({
        cwd,
        threadId: "saved-thread",
        model: "gpt-5.6-sol",
        prompt: "Continue planning.",
        requestId: "resume-1",
        onThread: async () => {},
      }),
    ).resolves.toMatchObject({ threadId: "saved-thread" });
    const recorded = await messages(logPath);
    expect(recorded.some((message) => message.method === "thread/start")).toBe(false);
    expect(recorded.find((message) => message.method === "thread/resume")).toMatchObject({
      params: { threadId: "saved-thread", sandbox: "read-only", approvalPolicy: "never" },
    });
  });

  it("cannot begin inference before the caller has durably saved the thread", async () => {
    const { cwd, logPath, runtime } = await fixture();
    await expect(
      runtime.runTurn({
        cwd,
        model: "gpt-5.6-sol",
        prompt: "Clarify the feature.",
        requestId: "storage-1",
        onThread: () => Promise.reject(new Error("Database unavailable")),
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    const recorded = await messages(logPath);
    expect(recorded.some((message) => message.method === "turn/start")).toBe(false);
    expect(recorded.at(-1)).toMatchObject({ cleanedUp: true });
  });

  it.each(["timeout", "cancelled"])(
    "interrupts and cleans up a stalled process after %s",
    async (code) => {
      const { cwd, logPath, runtime } = await fixture("stall", code === "timeout" ? 250 : 5_000);
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      try {
        await expect(
          runtime.runTurn({
            cwd,
            model: "gpt-5.6-sol",
            prompt: "Clarify the feature.",
            requestId: "stall-1",
            signal: controller.signal,
            onThread: () => {
              if (code === "cancelled") timer = setTimeout(() => controller.abort(), 50);
              return Promise.resolve();
            },
          }),
        ).rejects.toMatchObject({ code });
        const recorded = await messages(logPath);
        expect(recorded.some((message) => message.method === "turn/interrupt")).toBe(true);
        expect(recorded.at(-1)).toMatchObject({ cleanedUp: true });
        const pid = recorded[0]?.pid;
        expect(typeof pid).toBe("number");
        if (typeof pid !== "number") throw new Error("Missing fixture process");
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        clearTimeout(timer);
      }
    },
  );

  it("reports a missing executable without hanging or exposing process details", async () => {
    const { cwd } = await fixture();
    const runtime = createCodexPlanningRuntime({
      executable: join(cwd, "missing-codex"),
      timeoutMs: 1_000,
    });
    await expect(
      runtime.runTurn({
        cwd,
        model: "gpt-5.6-sol",
        prompt: "Clarify the feature.",
        requestId: "missing-1",
        onThread: async () => {},
      }),
    ).rejects.toMatchObject({ code: "unavailable", message: "Codex planning failed: unavailable" });
  });

  it("does not launch a process for a request already cancelled", async () => {
    const { cwd, logPath, runtime } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runtime.runTurn({
        cwd,
        model: "gpt-5.6-sol",
        prompt: "Clarify the feature.",
        requestId: "cancel-1",
        signal: controller.signal,
        onThread: async () => {},
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(readFile(logPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses a thread that silently changes the selected model", async () => {
    const { cwd, logPath, runtime } = await fixture("wrong_model");
    await expect(
      runtime.runTurn({
        cwd,
        model: "gpt-5.6-sol",
        prompt: "Clarify the feature.",
        requestId: "model-1",
        onThread: async () => {},
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect((await messages(logPath)).some((message) => message.method === "turn/start")).toBe(
      false,
    );
  });
  it("supports a host without configured MCP servers when every tool policy is disabled", async () => {
    const { cwd, runtime } = await fixture("no_mcp");
    await expect(
      runtime.runTurn({
        cwd,
        model: "gpt-5.6-sol",
        prompt: "Clarify the feature.",
        requestId: "no-mcp-1",
        onThread: async () => {},
      }),
    ).resolves.toMatchObject({ threadId: "thread-planning" });
  });
  it("returns a bounded runtime question without inventing the operator's answer", async () => {
    const { cwd, logPath, runtime } = await fixture("input_required");
    await expect(
      runtime.runTurn({
        cwd,
        model: "gpt-5.6-sol",
        prompt: "Clarify the feature.",
        requestId: "question-1",
        onThread: async () => {},
      }),
    ).rejects.toMatchObject({
      code: "input_required",
      question:
        "Quale risultato deve essere verificabile?\n- Export: Esportare i dati.\n- Search: Cercare i dati.",
    });
    const recorded = await messages(logPath);
    expect(recorded.some((message) => message.method === "turn/interrupt")).toBe(true);
    expect(recorded.find((message) => message.id === "question-1")).toMatchObject({
      result: { answers: {} },
    });
    expect(recorded.at(-1)).toMatchObject({ cleanedUp: true });
  });
  it("persists a verified thread before starting a turn and returns the completed fragmented answer", async () => {
    vi.stubEnv("OPENAI_API_KEY", "must_not_be_inherited");
    const { cwd, logPath, runtime } = await fixture();
    const onThread = vi.fn(async (threadId: string) => {
      expect(threadId).toBe("thread-planning");
      expect((await messages(logPath)).some((message) => message.method === "turn/start")).toBe(
        false,
      );
    });
    const outputSchema = { type: "object", properties: { question: { type: "string" } } };

    await expect(
      runtime.runTurn({
        cwd,
        model: "gpt-5.6-sol",
        prompt: "Plan from supplied Markdown.",
        requestId: "request-1",
        outputSchema,
        onThread,
      }),
    ).resolves.toEqual({
      threadId: "thread-planning",
      turnId: "turn-planning",
      text: "Quale risultato deve verificare il piano? 🪶",
    });

    const recorded = await messages(logPath);
    expect(recorded[0]).toMatchObject({ inheritedApiKey: false });
    expect(recorded[0]?.args).toEqual(
      expect.arrayContaining([
        "shell_tool",
        "apps",
        "plugins",
        "hooks",
        "browser_use",
        "browser_use_external",
        'web_search="disabled"',
      ]),
    );
    expect(recorded.find((message) => message.method === "config/read")).toMatchObject({
      params: { cwd, includeLayers: false },
    });
    expect(recorded.find((message) => message.method === "thread/start")).toMatchObject({
      params: {
        cwd,
        sandbox: "read-only",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        config: {
          mcp_servers: { "private.connector": { enabled: false }, local: { enabled: false } },
        },
      },
    });
    expect(recorded.find((message) => message.method === "turn/start")).toMatchObject({
      params: {
        threadId: "thread-planning",
        clientUserMessageId: "request-1",
        outputSchema,
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
    });
    expect(JSON.stringify(recorded)).not.toContain("secret_fixture_token");
    expect(onThread).toHaveBeenCalledOnce();
    expect(recorded.at(-1)).toMatchObject({ cleanedUp: true });
  });
});
