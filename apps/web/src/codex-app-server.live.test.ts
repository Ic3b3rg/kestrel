import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createCodexAppServerAgentRuntime } from "./codex-app-server.js";

const execFileAsync = promisify(execFile);

describe.runIf(process.env.KESTREL_LIVE_CODEX === "1")("Codex App Server live conformance", () => {
  it("reads bounded subscription readiness through the current Codex session", async () => {
    const connection = await createCodexAppServerAgentRuntime().readConnection();

    expect(connection.cli?.supported).toBe(true);
    expect(connection.cli?.protocol).toBe("app_server_v2");
    expect(connection.account?.authentication).toBe("chatgpt");
    expect(connection.models.length).toBeGreaterThan(0);
    expect(connection.usage).not.toBeNull();
    expect([null, "waiting_for_usage_reset", "usage_limit_reached"]).toContain(connection.reason);
    const { stdout: versionOutput } = await execFileAsync(
      process.env.KESTREL_CODEX_EXECUTABLE ?? "codex",
      ["--version"],
      { encoding: "utf8", maxBuffer: 1_024, timeout: 5_000 },
    );
    expect(versionOutput.trim()).toBe(`codex-cli ${connection.cli?.version ?? "missing"}`);
    expect(JSON.stringify(connection)).not.toMatch(/auth\.json|access.?token|refresh.?token/iu);
  }, 30_000);
});
