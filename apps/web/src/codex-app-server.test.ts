import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCodexAppServerAgentRuntime } from "./codex-app-server.js";

const temporaryDirectories: string[] = [];

async function writeFakeCodex(source: string): Promise<{ executable: string; logPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-codex-app-server-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "codex");
  const logPath = join(directory, "messages.jsonl");
  await writeFile(executable, source, { mode: 0o755 });
  await chmod(executable, 0o755);
  return { executable, logPath };
}

type FailureMode =
  | "api_key"
  | "cancelled"
  | "crashed"
  | "credential_field"
  | "escaped_pipe"
  | "logged_out"
  | "malformed"
  | "old_version"
  | "oversized"
  | "paginated"
  | "protocol_mismatch"
  | "timed_out"
  | "usage_action_required"
  | "usage_waiting";

async function writeFailureFake(mode: FailureMode) {
  const fixture = await writeFakeCodex(`#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [mode, actualLogPath, descendantMarker] = process.argv.slice(2);
if (mode === "crashed") process.exit(17);
const lines = createInterface({ input: process.stdin });
const startDescendant = () => {
  const descendantDelay = mode === "timed_out" ? 5500 : 250;
  spawn(process.execPath, ["-e", \`setTimeout(() => require("node:fs").writeFileSync(\${JSON.stringify(descendantMarker)}, "leaked"), \${descendantDelay})\`], {
    stdio: "ignore"
  });
};
lines.on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(actualLogPath, JSON.stringify({ method: message.method }) + "\\n");
  if (message.method === "initialize") {
    if (mode === "timed_out" || mode === "cancelled") {
      startDescendant();
      return;
    }
    if (mode === "malformed") {
      process.stdout.write("provider_secret_should_not_escape\\n");
      return;
    }
    if (mode === "oversized") {
      process.stdout.write("x".repeat(2 * 1024 * 1024 + 1));
      return;
    }
    if (mode === "escaped_pipe") {
      const escaped = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 5000)"], {
        detached: true,
        stdio: ["ignore", process.stdout, "ignore"]
      });
      escaped.unref();
    }
    console.log(JSON.stringify({ id: message.id, result: mode === "protocol_mismatch" ? {
      protocolVersion: 1
    } : {
      codexHome: "/private/operator/.codex",
      platformFamily: "unix",
      platformOs: "macos",
      userAgent: mode === "old_version"
        ? "kestrel/0.151.0 (Mac OS; arm64) terminal (kestrel; 0.0.0)"
        : "kestrel/0.152.1 (Mac OS; arm64) terminal (kestrel; 0.0.0)"
    }}));
  } else if (message.method === "account/read") {
    console.log(JSON.stringify({ id: message.id, result: mode === "logged_out" ? {
      account: null,
      requiresOpenaiAuth: true
    } : mode === "api_key" ? {
      account: { type: "apiKey" },
      requiresOpenaiAuth: false
    } : mode === "credential_field" ? {
      account: { type: "chatgpt", email: "operator@example.com", planType: "plus" },
      requiresOpenaiAuth: true,
      refreshToken: "provider_secret_should_not_escape"
    } : {
      account: { type: "chatgpt", email: "operator@example.com", planType: "plus" },
      requiresOpenaiAuth: true
    }}));
  } else if (message.method === "model/list") {
    const secondPage = mode === "paginated" && message.params.cursor === "page-2";
    console.log(JSON.stringify({ id: message.id, result: {
      data: [{
        id: secondPage ? "gpt-5.6-terra" : "gpt-5.6-sol",
        model: secondPage ? "gpt-5.6-terra" : "gpt-5.6-sol",
        displayName: secondPage ? "GPT-5.6 Terra" : "GPT-5.6 Sol",
        description: "Frontier coding model",
        hidden: false,
        isDefault: !secondPage,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: []
      }],
      nextCursor: mode === "paginated" && !secondPage ? "page-2" : null
    }}));
  } else if (message.method === "account/rateLimits/read") {
    const reached = mode === "usage_waiting"
      ? "rate_limit_reached"
      : mode === "usage_action_required"
        ? "workspace_member_usage_limit_reached"
        : null;
    console.log(JSON.stringify({ id: message.id, result: { rateLimits: {
      planType: "plus",
      primary: { usedPercent: reached === null ? 25 : 100, windowDurationMins: 300, resetsAt: 1788386400 },
      secondary: null,
      rateLimitReachedType: reached,
      spendControlReached: false
    }}}));
  }
});
lines.on("close", () => appendFileSync(actualLogPath, JSON.stringify({ cleanedUp: true }) + "\\n"));
`);
  const descendantMarker = join(join(fixture.executable, ".."), "descendant-leak");
  return {
    ...fixture,
    descendantMarker,
    runtime: createCodexAppServerAgentRuntime({
      executable: fixture.executable,
      arguments: [mode, fixture.logPath, descendantMarker, "app-server", "--stdio"],
      timeoutMs: mode === "timed_out" ? 5_000 : 10_000,
    }),
  };
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function waitForLog(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path, "utf8")).includes(expected)) return;
    } catch {
      // The fake process has not created its log yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Fake Codex did not record ${expected}`);
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Codex App Server Agent Runtime port", () => {
  it("initializes one bounded process and returns normalized subscription readiness after cleanup", async () => {
    const fixture = await writeFakeCodex(`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const actualLogPath = process.argv[2];
appendFileSync(actualLogPath, JSON.stringify({
  args: process.argv.slice(3),
  inheritedApiKey: Object.hasOwn(process.env, "OPENAI_API_KEY")
}) + "\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(actualLogPath, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: {
      codexHome: "/private/operator/.codex",
      platformFamily: "unix",
      platformOs: "macos",
      userAgent: "kestrel/0.152.1 (Mac OS; arm64) terminal (kestrel; 0.0.0)"
    }}));
  } else if (message.method === "account/read") {
    console.log(JSON.stringify({ id: message.id, result: {
      account: { type: "chatgpt", email: "operator@example.com", planType: "plus" },
      requiresOpenaiAuth: true
    }}));
  } else if (message.method === "model/list") {
    console.log(JSON.stringify({ id: message.id, result: {
      data: [{
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        description: "Frontier coding model",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: []
      }],
      nextCursor: null
    }}));
  } else if (message.method === "account/rateLimits/read") {
    console.log(JSON.stringify({ id: message.id, result: {
      rateLimits: {
        planType: "plus",
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1788386400 },
        secondary: null,
        rateLimitReachedType: null,
        spendControlReached: false
      }
    }}));
  }
});
lines.on("close", () => {
  appendFileSync(actualLogPath, JSON.stringify({ cleanedUp: true }) + "\\n");
});
`);
    vi.stubEnv("OPENAI_API_KEY", "provider_secret_should_not_be_copied");
    const runtime = createCodexAppServerAgentRuntime({
      executable: fixture.executable,
      arguments: [fixture.logPath, "app-server", "--stdio"],
      timeoutMs: 10_000,
    });

    const connection = await runtime.readConnection();
    expect(connection).toEqual({
      schemaVersion: 1,
      state: "ready",
      reason: null,
      cli: { version: "0.152.1", supported: true, protocol: "app_server_v2" },
      account: { authentication: "chatgpt", email: "operator@example.com", plan: "plus" },
      models: [{ id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", isDefault: true }],
      usage: {
        availability: "available",
        primary: {
          usedPercent: 25,
          windowDurationMinutes: 300,
          resetsAt: "2026-09-02T22:00:00.000Z",
        },
        secondary: null,
      },
      checkedAt: connection.checkedAt,
    });
    expect(new Date(connection.checkedAt).toISOString()).toBe(connection.checkedAt);

    const messages = (await readFile(fixture.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(messages[0]).toEqual({
      args: ["app-server", "--stdio"],
      inheritedApiKey: false,
    });
    expect(messages.map(({ method }) => method).filter(Boolean)).toEqual([
      "initialize",
      "initialized",
      "account/read",
      "model/list",
      "account/rateLimits/read",
    ]);
    expect(messages.at(-1)).toEqual({ cleanedUp: true });
    expect(JSON.stringify(messages)).not.toContain("auth.json");
  });

  it.each([
    ["old_version", "cli_version_unsupported", { version: "0.151.0", supported: false }],
    ["protocol_mismatch", "protocol_unsupported", null],
    ["logged_out", "authentication_required", { version: "0.152.1", supported: true }],
    ["api_key", "chatgpt_subscription_required", { version: "0.152.1", supported: true }],
  ] as const)("fails closed for %s with typed remediation facts", async (mode, reason, cli) => {
    const fixture = await writeFailureFake(mode);

    const connection = await fixture.runtime.readConnection();

    expect(connection).toMatchObject({ state: "action_required", reason, cli });
    expect(connection.account).toBeNull();
    expect(connection.models).toEqual([]);
    expect(connection.usage).toBeNull();
    expect(JSON.stringify(connection)).not.toMatch(/auth\.json|token|provider_secret/iu);
    expect((await readFile(fixture.logPath, "utf8")).trimEnd()).toMatch(/cleanedUp/);
  });

  it.each([
    ["malformed", "unexpected_response"],
    ["oversized", "unexpected_response"],
    ["crashed", "unexpected_response"],
    ["timed_out", "timed_out"],
  ] as const)(
    "bounds and cleans up a %s App Server",
    async (mode, reason) => {
      const fixture = await writeFailureFake(mode);

      const connection = await fixture.runtime.readConnection();

      expect(connection).toMatchObject({ state: "unavailable", reason });
      expect(JSON.stringify(connection)).not.toMatch(/auth\.json|token|provider_secret/iu);
      if (mode === "timed_out") {
        await new Promise((resolve) => setTimeout(resolve, 750));
        await expectMissing(fixture.descendantMarker);
      }
    },
    15_000,
  );

  it("reports a missing executable without disclosing its path", async () => {
    const executable = join(tmpdir(), "kestrel-codex-never-created");

    const connection = await createCodexAppServerAgentRuntime({ executable }).readConnection();

    expect(connection).toMatchObject({
      state: "action_required",
      reason: "cli_not_installed",
      cli: null,
    });
    expect(JSON.stringify(connection)).not.toContain(executable);
  });

  it("refuses a relative executable even when PATH could resolve it", async () => {
    const fixture = await writeFailureFake("logged_out");
    vi.stubEnv("PATH", `${dirname(fixture.executable)}${delimiter}${process.env.PATH ?? ""}`);

    const connection = await createCodexAppServerAgentRuntime({
      executable: "codex",
      arguments: ["logged_out", fixture.logPath, fixture.descendantMarker, "app-server", "--stdio"],
    }).readConnection();

    expect(connection).toMatchObject({ reason: "cli_not_installed", cli: null });
    await expectMissing(fixture.logPath);
  });

  it("rejects unexpected credential-shaped App Server fields", async () => {
    const fixture = await writeFailureFake("credential_field");

    const connection = await fixture.runtime.readConnection();

    expect(connection).toMatchObject({ state: "unavailable", reason: "unexpected_response" });
    expect(JSON.stringify(connection)).not.toContain("provider_secret_should_not_escape");
  });

  it("reads a bounded paginated model catalog", async () => {
    const fixture = await writeFailureFake("paginated");

    const connection = await fixture.runtime.readConnection();

    expect(connection).toMatchObject({
      state: "ready",
      models: [
        { id: "gpt-5.6-sol", isDefault: true },
        { id: "gpt-5.6-terra", isDefault: false },
      ],
    });
    expect((await readFile(fixture.logPath, "utf8")).match(/model\/list/gu)).toHaveLength(2);
  });

  it("keeps cleanup bounded when an escaped process retains the stdout pipe", async () => {
    const fixture = await writeFailureFake("escaped_pipe");
    const startedAt = Date.now();

    const connection = await fixture.runtime.readConnection();

    expect(connection.state).toBe("ready");
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  }, 7_000);

  it.each([
    ["usage_waiting", "waiting_for_usage_reset", "waiting_for_usage_reset"],
    ["usage_action_required", "action_required", "usage_limit_reached"],
  ] as const)("classifies %s from typed usage facts", async (mode, state, reason) => {
    const fixture = await writeFailureFake(mode);

    const connection = await fixture.runtime.readConnection();

    expect(connection).toMatchObject({
      state,
      reason,
      usage: {
        availability:
          mode === "usage_waiting"
            ? "waiting_for_usage_reset"
            : "usage_limit_reached_action_required",
      },
    });
  });

  it("propagates cancellation only after cleaning up the process tree", async () => {
    const fixture = await writeFailureFake("cancelled");
    const controller = new AbortController();
    const connection = fixture.runtime.readConnection(controller.signal);
    await waitForLog(fixture.logPath, '"method":"initialize"');
    controller.abort();

    await expect(connection).rejects.toMatchObject({ kind: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 350));
    await expectMissing(fixture.descendantMarker);
  }, 15_000);
});
