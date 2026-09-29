import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { GeneratedFeaturePlanDocumentSchema, NamedPlanningReplySchema } from "@kestrel/contracts";
import { createCodexPlanningRuntime } from "../../../apps/web/src/codex-planning-runtime.js";
import { interviewCodexFixture } from "./interview-codex-fixture.js";
it("acceptance provider returns the actual named reply protocol and Markdown", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "kestrel-interview-provider-")));
  try {
    const script = join(cwd, "fixture.cjs");
    await writeFile(script, interviewCodexFixture);
    const runtime = createCodexPlanningRuntime({
      executable: process.execPath,
      arguments: [script],
    });
    const result = await runtime.runTurn({
      cwd,
      model: "controlled-model",
      prompt: '<selected_planning_skills>[{"name":"brainstorming"}]</selected_planning_skills>',
      requestId: "fixture",
      onThread: () => Promise.resolve(),
      outputSchema: z.toJSONSchema(NamedPlanningReplySchema, { target: "draft-7" }),
    });
    const reply = NamedPlanningReplySchema.parse(JSON.parse(result.text));
    expect(reply.text).toContain("## Interview findings\n\nProcedure: **brainstorming**");
    const generated = await runtime.runTurn({
      cwd,
      model: "controlled-model",
      prompt: "Generate requirements",
      requestId: "generation",
      onThread: () => Promise.resolve(),
      outputSchema: z.toJSONSchema(GeneratedFeaturePlanDocumentSchema, { target: "draft-7" }),
    });
    expect(
      GeneratedFeaturePlanDocumentSchema.parse(JSON.parse(generated.text)).workItems,
    ).toHaveLength(2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
