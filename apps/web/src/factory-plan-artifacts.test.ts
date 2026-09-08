import { describe, expect, it } from "vitest";

import type { FeaturePlanDocument, PlanningContext } from "@kestrel/contracts";

import { CodexPlanningError } from "./codex-planning-runtime.js";
import { parseGeneratedFeaturePlan, renderFeaturePlanArtifacts } from "./factory-plan-artifacts.js";

function plan(): FeaturePlanDocument {
  return {
    objective: "Export saved notes as Markdown.",
    proposedDocuments: [],
    scope: { includes: ["Export all saved notes"], excludes: ["Import notes"] },
    acceptance: [
      { key: "format", outcome: "Exported notes retain their Markdown body." },
      { key: "download", outcome: "The Operator can download every saved note." },
    ],
    workItems: [
      {
        key: "serialize",
        title: "Serialize a note",
        description: "Preserve the title and body exactly.",
        importedIssueId: null,
        requirementKeys: ["format"],
        acceptance: ["Unicode text survives serialization."],
        dependsOn: [],
        verification: [
          {
            program: "node",
            args: ["--test", "test/serialize.test.mjs"],
            cwd: "packages/export",
            timeoutSeconds: 45,
          },
        ],
      },
      {
        key: "download",
        title: "Download notes",
        description: "Offer an export action in the notes list.",
        importedIssueId: null,
        requirementKeys: ["format", "download"],
        acceptance: ["Downloading includes every saved note."],
        dependsOn: ["serialize"],
        verification: [
          {
            program: "npm",
            args: ["run", "test:browser", "--", "export.spec.ts"],
            cwd: ".",
            timeoutSeconds: 120,
          },
        ],
      },
    ],
    limits: {
      maxConcurrentProjects: 2,
      maxActiveFeaturesPerProject: 1,
      attemptTimeoutSeconds: 1800,
    },
  };
}

describe("generated Feature Plan parsing", () => {
  it("requires an explicit proposed-documents decision in new model output", () => {
    const document = plan();
    delete document.proposedDocuments;
    expect(() => parseGeneratedFeaturePlan(JSON.stringify(document))).toThrow(
      new CodexPlanningError("invalid_response"),
    );
  });
  it("accepts the complete structured plan without inventing or dropping details", () => {
    const document = plan();
    expect(parseGeneratedFeaturePlan(JSON.stringify(document))).toEqual(document);
  });

  it.each([
    "not JSON: secret-output",
    "```json\n{}\n```",
    "null",
    "[]",
    '{"objective":"secret-output"}',
  ])("rejects malformed or incomplete output without exposing it: %s", (output) => {
    expect(() => parseGeneratedFeaturePlan(output)).toThrow(
      new CodexPlanningError("invalid_response"),
    );
  });

  it("rejects extra fields instead of salvaging an assistant answer", () => {
    const output = JSON.stringify({ ...plan(), assistantAnswer: "secret-output" });
    expect(() => parseGeneratedFeaturePlan(output)).toThrow(
      new CodexPlanningError("invalid_response"),
    );
  });

  it("rejects an invalid dependency graph without reordering the displayed work", () => {
    const document = plan();
    document.workItems.reverse();
    expect(() => parseGeneratedFeaturePlan(JSON.stringify(document))).toThrow(
      new CodexPlanningError("invalid_response"),
    );
  });

  it("rejects a requirement with no planned implementation", () => {
    const document = plan();
    document.acceptance.push({ key: "secret-output", outcome: "Preserve attachments." });
    expect(() => parseGeneratedFeaturePlan(JSON.stringify(document))).toThrow(
      new CodexPlanningError("invalid_response"),
    );
  });

  it("rejects verification outside the project even when the JSON shape is valid", () => {
    const document = plan();
    document.workItems = document.workItems.map((item) => ({
      ...item,
      verification: [{ program: "node", args: [], cwd: "../secret-output", timeoutSeconds: 1 }],
    }));
    expect(() => parseGeneratedFeaturePlan(JSON.stringify(document))).toThrow(
      new CodexPlanningError("invalid_response"),
    );
  });
});

describe("Feature Plan Markdown artifacts", () => {
  it("retains proposed document bytes, ownership and provisional paths as draft artifacts", () => {
    const document = plan();
    const markdown =
      "# Export ADR\n\n```md\n  preserve indentation\n```\n\n## Not a plan instruction\n";
    document.proposedDocuments = [
      {
        key: "export-adr",
        kind: "adr",
        path: "docs/adr/NNNN-export.md",
        pathIsProvisional: true,
        markdown,
        workItemKey: "serialize",
      },
    ];
    const artifacts = renderFeaturePlanArtifacts({
      title: "Export",
      version: 3,
      plan: document,
      context: null,
    });
    for (const content of Object.values(artifacts)) {
      expect(content).toContain("## Proposed Project documents");
      expect(content).toContain("docs/adr/NNNN-export.md");
      expect(content).toContain("Provisional path");
      expect(content).toContain("serialize");
    }
    expect(artifacts.planMarkdown).toContain("````markdown\n" + markdown + "````");
    expect(document.proposedDocuments[0]?.markdown).toBe(markdown);
  });
  it("preserves ordered work, requirement links, verification, limits, and committed source references", () => {
    const document = plan();
    const context: PlanningContext = {
      commitId: "1234567890abcdef1234567890abcdef12345678",
      documents: [
        {
          path: "CONTEXT.md",
          objectId: "abcdef1234567890abcdef1234567890abcdef12",
          content: "Source body is retained in the version's structured context.",
        },
        {
          path: "docs/adr/0001-export.md",
          objectId: "0123456789abcdef0123456789abcdef01234567",
          content: "Committed export decisions.",
        },
      ],
      notice: "Additional documents were omitted because the context limit was reached.",
    };
    const input = { title: "Export notes", version: 3, plan: document, context };
    const originalInput = structuredClone(input);
    const { planMarkdown, specMarkdown } = renderFeaturePlanArtifacts(input);

    for (const markdown of [planMarkdown, specMarkdown]) {
      expect(markdown).toContain("Export notes");
      expect(markdown).toContain("Version: 3");
      expect(markdown).toContain("Export saved notes as Markdown.");
      expect(markdown).toContain("Export all saved notes");
      expect(markdown).toContain("Import notes");
      expect(markdown).toContain("**format**: Exported notes retain their Markdown body.");
      expect(markdown).toContain("**download**: The Operator can download every saved note.");
      expect(markdown).toContain("Concurrent Projects: 2");
      expect(markdown).toContain("Active Features per Project: 1");
      expect(markdown).toContain("Execution attempt timeout: 1800 seconds");
      expect(markdown).toContain("Source commit: `1234567890abcdef1234567890abcdef12345678`");
      expect(markdown).toContain("`CONTEXT.md` — blob `abcdef1234567890abcdef1234567890abcdef12`");
      expect(markdown).toContain(
        "`docs/adr/0001-export.md` — blob `0123456789abcdef0123456789abcdef01234567`",
      );
      expect(markdown).toContain(context.notice);
      expect(markdown).not.toContain("Source body is retained");
      expect(markdown).not.toMatch(/approved at|created at|status:|draft|pending approval/iu);
    }
    expect(planMarkdown).toContain("### 1. serialize — Serialize a note");
    expect(planMarkdown).toContain("Preserve the title and body exactly.");
    expect(planMarkdown).toContain("Requirements: format\n");
    expect(planMarkdown).toContain("Dependencies: None\n");
    expect(planMarkdown).toContain("Unicode text survives serialization.");
    expect(planMarkdown).toContain("### 2. download — Download notes");
    expect(planMarkdown).toContain("Offer an export action in the notes list.");
    expect(planMarkdown).toContain("Requirements: format, download\n");
    expect(planMarkdown).toContain("Dependencies: serialize\n");
    expect(planMarkdown).toContain("Downloading includes every saved note.");
    expect(planMarkdown.indexOf("### 1. serialize")).toBeLessThan(
      planMarkdown.indexOf("### 2. download"),
    );
    expect(specMarkdown).toContain("Work Items: serialize, download");
    expect(specMarkdown).toContain("Work Items: download");
    const verification = [...planMarkdown.matchAll(/```json\n([\s\S]*?)\n```/gu)].map(
      (match): unknown => JSON.parse(match[1] ?? "null"),
    );
    expect(verification).toEqual([
      {
        argv: ["node", "--test", "test/serialize.test.mjs"],
        cwd: "packages/export",
        timeoutSeconds: 45,
      },
      {
        argv: ["npm", "run", "test:browser", "--", "export.spec.ts"],
        cwd: ".",
        timeoutSeconds: 120,
      },
    ]);
    expect(renderFeaturePlanArtifacts(input)).toEqual({ planMarkdown, specMarkdown });
    expect(input).toEqual(originalInput);
  });

  it("keeps multiple verification commands and exact argument boundaries without shell interpolation", () => {
    const document = plan();
    const command = {
      program: "node",
      args: [
        "",
        "space value",
        "'quoted'",
        "$(not a command)",
        "--message=a\n```\nb",
        "back\\slash",
      ],
      cwd: "packages/export tests",
      timeoutSeconds: 17,
    };
    document.workItems = document.workItems.map((item) =>
      item.key === "serialize" ? { ...item, verification: [...item.verification, command] } : item,
    );
    const { planMarkdown } = renderFeaturePlanArtifacts({
      title: "Export notes",
      version: 1,
      plan: document,
      context: null,
    });
    const verification = [...planMarkdown.matchAll(/```json\n([\s\S]*?)\n```/gu)].map(
      (match): unknown => JSON.parse(match[1] ?? "null"),
    );

    expect(verification).toHaveLength(3);
    expect(verification[1]).toEqual({
      argv: [
        "node",
        "",
        "space value",
        "'quoted'",
        "$(not a command)",
        "--message=a\n```\nb",
        "back\\slash",
      ],
      cwd: "packages/export tests",
      timeoutSeconds: 17,
    });
  });

  it.each<{ context: PlanningContext | null; disclosures: string[] }>([
    {
      context: null,
      disclosures: [
        "No planning source context was available.",
        "Source commit and document references are unavailable.",
      ],
    },
    {
      context: { commitId: null, documents: [], notice: "Source documentation is missing." },
      disclosures: [
        "Source commit: Unavailable.",
        "No committed planning documents were available.",
        "Context notice: Source documentation is missing.",
      ],
    },
    {
      context: {
        commitId: "1234567890abcdef1234567890abcdef12345678",
        documents: [],
        notice: null,
      },
      disclosures: [
        "Source commit: `1234567890abcdef1234567890abcdef12345678`",
        "No committed planning documents were available.",
      ],
    },
  ])("discloses missing source context in both artifacts: $context", ({ context, disclosures }) => {
    const document = plan();
    document.scope.excludes = [];
    const artifacts = renderFeaturePlanArtifacts({
      title: "Export notes",
      version: 1,
      plan: document,
      context,
    });
    for (const markdown of Object.values(artifacts)) {
      expect(markdown).toContain("### Excluded\n\n- None");
      for (const disclosure of disclosures) expect(markdown).toContain(disclosure);
    }
  });

  it("keeps backticks in a document path inside one Markdown code span", () => {
    const context: PlanningContext = {
      commitId: "1234567890abcdef1234567890abcdef12345678",
      documents: [
        {
          path: "docs/`export`.md",
          objectId: "abcdef1234567890abcdef1234567890abcdef12",
          content: "Export docs.",
        },
      ],
      notice: null,
    };
    const artifacts = renderFeaturePlanArtifacts({
      title: "Export notes",
      version: 1,
      plan: plan(),
      context,
    });
    for (const markdown of Object.values(artifacts)) {
      expect(markdown).toContain(
        "``docs/`export`.md`` — blob `abcdef1234567890abcdef1234567890abcdef12`",
      );
    }
  });
});
