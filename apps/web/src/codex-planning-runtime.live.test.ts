import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createCodexAppServerAgentRuntime } from "./codex-app-server.js";
import { createCodexPlanningRuntime } from "./codex-planning-runtime.js";

const execFileAsync = promisify(execFile);

describe.runIf(process.env.KESTREL_LIVE_CODEX_PLANNING === "1")(
  "Codex planning live conformance",
  () => {
    it("plans and resumes against supplied fixture Markdown without altering its source", async () => {
      const { stdout } = await execFileAsync("/usr/bin/which", ["codex"], {
        encoding: "utf8",
        maxBuffer: 1_024,
        timeout: 5_000,
      });
      const executable = await realpath(process.env.KESTREL_CODEX_EXECUTABLE ?? stdout.trim());
      const connection = await createCodexAppServerAgentRuntime({ executable }).readConnection();
      expect(connection.state).toBe("ready");
      expect(connection.account?.authentication).toBe("chatgpt");
      const model = connection.models.find((candidate) => candidate.isDefault)?.id;
      if (model === undefined) throw new Error("Codex has no available default model");

      const cwd = await realpath(await mkdtemp(join(tmpdir(), "kestrel-live-planning-")));
      const document =
        "# Fixture product\nA notes application stores titled notes locally. A requested feature exports notes. The export format is undecided.\n";
      const outputSchema = {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
        additionalProperties: false,
      };
      try {
        await writeFile(join(cwd, "CONTEXT.md"), document);
        const runtime = createCodexPlanningRuntime({ executable, timeoutMs: 60_000 });
        const result = await runtime.runTurn({
          cwd,
          model,
          requestId: "fixture-planning-1",
          outputSchema,
          prompt: `This is a disposable integration fixture. Use only the following supplied CONTEXT.md. Ask one short question about the missing export requirement. Return JSON with a question string. Do not use tools.\n\n${document}`,
          onThread: (threadId) => writeFile(join(cwd, "saved-thread"), threadId),
        });
        expect(
          z.strictObject({ question: z.string().min(5).max(2_000) }).parse(JSON.parse(result.text))
            .question,
        ).toContain("?");
        expect(await readFile(join(cwd, "saved-thread"), "utf8")).toBe(result.threadId);

        const resumed = await runtime.runTurn({
          cwd,
          model,
          threadId: result.threadId,
          requestId: "fixture-planning-2",
          outputSchema,
          prompt:
            "The export format is Markdown. Ask one remaining acceptance question in JSON with a question string; do not use tools.",
          onThread: (threadId) => writeFile(join(cwd, "saved-thread"), threadId),
        });
        expect(resumed.threadId).toBe(result.threadId);
        expect(
          z.strictObject({ question: z.string().min(5).max(2_000) }).parse(JSON.parse(resumed.text))
            .question,
        ).toContain("?");
        expect(await readFile(join(cwd, "CONTEXT.md"), "utf8")).toBe(document);
        expect((await readdir(cwd)).sort()).toEqual(["CONTEXT.md", "saved-thread"]);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }, 150_000);
  },
);
