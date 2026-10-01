import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { BoardIssuePlanResultSchema, parseBoardIssuePlanResult } from "./factory-plan-artifacts.js";
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

describe.runIf(process.env.KESTREL_LIVE_CODEX_ATTACHMENTS === "1")(
  "Codex attachment live conformance",
  () => {
    it("reads actual image pixels and retained text in one planning turn", async () => {
      const { stdout } = await execFileAsync("/usr/bin/which", ["codex"], {
        encoding: "utf8",
        timeout: 5000,
      });
      const executable = await realpath(process.env.KESTREL_CODEX_EXECUTABLE ?? stdout.trim());
      const connection = await createCodexAppServerAgentRuntime({ executable }).readConnection();
      expect(connection.state).toBe("ready");
      const model =
        connection.models.find((model) => model.isDefault)?.model ??
        connection.models.find((model) => model.isDefault)?.id;
      if (!model) throw new Error("No available Codex model");
      const cwd = await realpath(await mkdtemp(join(tmpdir(), "kestrel-live-composer-")));
      try {
        const result = await createCodexPlanningRuntime({ executable, timeoutMs: 90000 }).runTurn({
          cwd,
          model,
          requestId: "kestrel-composer-attachment-fixture",
          onThread: async () => {},
          prompt:
            "Disposable verification fixture. Read the attached image and text. Return JSON with color (the image dominant color in English, lowercase) and keyword (the exact code in the text file). Do not use tools.",
          outputSchema: {
            type: "object",
            properties: { color: { type: "string" }, keyword: { type: "string" } },
            required: ["color", "keyword"],
            additionalProperties: false,
          },
          attachments: [
            {
              messageId: "fixture",
              file: {
                kind: "image",
                name: "sample.png",
                mediaType: "image/png",
                data: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC",
              },
            },
            {
              messageId: "fixture",
              file: {
                kind: "text",
                name: "code.txt",
                text: "Verification code: NORTHERN-OTTER-47",
              },
            },
          ],
        });
        expect(JSON.parse(result.text)).toEqual({ color: "red", keyword: "NORTHERN-OTTER-47" });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }, 120000);
  },
);

it.runIf(process.env.KESTREL_LIVE_CODEX_PLANNING === "1")(
  "prepares a ready issue by reading its contract and test command without an Operator question",
  async () => {
    const { stdout } = await execFileAsync("/usr/bin/which", ["codex"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024,
    });
    const executable = await realpath(process.env.KESTREL_CODEX_EXECUTABLE ?? stdout.trim());
    const connection = await createCodexAppServerAgentRuntime({ executable }).readConnection();
    const model = connection.models.find((candidate) => candidate.id === "gpt-6.1-sol")?.model;
    if (model === undefined) throw new Error("GPT-6.1-Sol is absent from the live catalog");
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "kestrel-ready-issue-live-")));
    const reads: unknown[] = [];
    try {
      const result = await createCodexPlanningRuntime({ executable, timeoutMs: 90_000 }).runTurn({
        cwd,
        model,
        requestId: "ready-issue-sources",
        onThread: async () => {},
        outputSchema: z.toJSONSchema(BoardIssuePlanResultSchema, { target: "draft-7" }),
        prompt:
          "Prepare a complete executable plan for the already authorized issue #42: export a note as Markdown preserving Unicode. Exactly one Work Item must bind importedIssueId 01991c36-7f90-7000-8000-000000000001. This issue cites contract #49. Before preparing the plan use read_project to read_issue number 49 page 1, then read_file package.json. Use the supplied test command. All product requirements are settled: preserve note body exactly, no import or unrelated changes. Resolve implementation details yourself. Use limits maxConcurrentProjects 2, maxActiveFeaturesPerProject 1, attemptTimeoutSeconds 1800. Return status ready and the complete plan when sources establish the requirements. Missing technical facts must be read, not requested from the Operator.",
        readProject: (value) => {
          reads.push(value);
          const request = z
            .object({
              operation: z.string(),
              number: z.number().optional(),
              path: z.string().optional(),
            })
            .parse(value);
          if (request.operation === "read_issue" && request.number === 49)
            return Promise.resolve({
              issue: {
                number: 49,
                state: "closed",
                body: "Serialize the note body exactly as UTF-8 Markdown. The export must preserve Unicode and line breaks. Implementation module: export.mjs.",
              },
              comments: [],
              nextPage: null,
            });
          if (request.operation === "read_file" && request.path === "package.json")
            return Promise.resolve({
              content: JSON.stringify({
                type: "module",
                scripts: { test: "node --test export.test.mjs" },
              }),
              nextOffset: null,
            });
          return Promise.resolve({
            error: "No other sources are needed for this bounded fixture.",
          });
        },
      });
      const parsed = parseBoardIssuePlanResult(result.text);
      expect(parsed.status).toBe("ready");
      if (parsed.status !== "ready") throw new Error("Ready issue unexpectedly required input");
      expect(parsed.plan.workItems).toHaveLength(1);
      expect(parsed.plan.workItems[0]?.importedIssueId).toBe(
        "01991c36-7f90-7000-8000-000000000001",
      );
      expect(reads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: "read_issue", number: 49 }),
          expect.objectContaining({ operation: "read_file", path: "package.json" }),
        ]),
      );
      expect(
        parsed.plan.workItems[0]?.verification.some(
          (command) =>
            (command.program === "node" && command.args.includes("export.test.mjs")) ||
            (command.program === "npm" && command.args.includes("test")),
        ),
      ).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120_000,
);
