import { describe, expect, it } from "vitest";

import {
  ChangeOverviewRenderingValidationError,
  prepareChangeOverviewRendering,
  validateChangeOverviewRendering,
} from "./change-overview.js";

const sha = (character: string) => character.repeat(40);

function sourceFacts(changedFileCount = 2) {
  return {
    ruleVersion: 1 as const,
    commitStatistics: { baseTreeFileCount: 18, headTreeFileCount: 20 },
    fileStatistics: {
      added: 0,
      modified: changedFileCount,
      deleted: 0,
      total: changedFileCount,
    },
    changedFiles: Array.from({ length: changedFileCount }, (_, index) => ({
      path: index % 2 === 0 ? `src/change-${String(index)}.ts` : `tests/change-${String(index)}.ts`,
      status: "modified" as const,
      base: { mode: "100644" as const, objectId: sha("a"), type: "blob" as const },
      head: { mode: "100644" as const, objectId: sha("b"), type: "blob" as const },
    })),
    pathAreas: [
      { pathPrefix: "src", changedFileCount: 1, samplePaths: ["src/change-0.ts"] },
      { pathPrefix: "tests", changedFileCount: 1, samplePaths: ["tests/change-1.ts"] },
    ],
    warnings: [],
  };
}

function prepared(changedFileCount = 2) {
  return prepareChangeOverviewRendering({
    exactRevision: {
      objectFormat: "sha1",
      base: {
        author: "Base Author",
        objectId: sha("c"),
        ref: "refs/heads/main",
        subject: "Establish the source boundary",
      },
      head: {
        author: "Head Author",
        objectId: sha("d"),
        ref: "refs/heads/change",
        subject: "Describe the retained change",
      },
    },
    sourceFacts: sourceFacts(changedFileCount),
  });
}

describe("Change Overview model rendering", () => {
  it("builds one bounded fact-only request with a strict citation schema", () => {
    const request = prepared(70);
    const serializedManifest = JSON.stringify(request.manifest);
    const outputSchema = request.output.schema as {
      properties: {
        sentences: { items: { properties: { sourceFactIds: { items: { enum: string[] } } } } };
      };
    };

    expect(request.input).toBe(serializedManifest);
    expect(Buffer.byteLength(request.input, "utf8")).toBeLessThanOrEqual(48 * 1_024);
    expect(request.inputTokenCount).toBe(Math.ceil(Buffer.byteLength(request.input, "utf8") / 4));
    expect(request.manifest.facts.filter(({ kind }) => kind === "changed_file")).toHaveLength(40);
    expect(request.manifest.facts).toContainEqual({
      id: "manifest_bounds",
      kind: "manifest_bounds",
      value: { omittedChangedFiles: 30, omittedPathAreas: 0 },
    });
    expect(outputSchema.properties.sentences.items.properties.sourceFactIds.items.enum).toEqual(
      request.manifest.facts.map(({ id }) => id),
    );
    expect(JSON.stringify(request.output.schema)).toContain('"additionalProperties":false');
    expect(JSON.stringify(request.output.schema)).not.toContain('"uniqueItems"');
    expect(JSON.stringify(request.output.schema)).toContain('"maxItems":1');
    expect(JSON.stringify(request.output.schema)).toContain(
      "must not describe behavior, purpose, quality, correctness, causality, risk",
    );
    expect(request.input).not.toContain("repositoryContent");
    expect(request.input).not.toContain("diff");
  });

  it("accepts concise orientation sentences whose material facts are cited", () => {
    const request = prepared();

    expect(
      validateChangeOverviewRendering(request.manifest, {
        sentences: [
          {
            text: "The retained change modifies 2 files.",
            sourceFactIds: ["file_statistics"],
          },
          {
            text: "The exact head is dddddddddddddddddddddddddddddddddddddddd.",
            sourceFactIds: ["exact_revision"],
          },
          {
            text: "The `src` source area contains 1 changed file.",
            sourceFactIds: ["path_area_001"],
          },
        ],
      }),
    ).toEqual({
      sentences: [
        {
          text: "The retained change modifies 2 files.",
          sourceFactIds: ["file_statistics"],
        },
        {
          text: "The exact head is dddddddddddddddddddddddddddddddddddddddd.",
          sourceFactIds: ["exact_revision"],
        },
        {
          text: "The `src` source area contains 1 changed file.",
          sourceFactIds: ["path_area_001"],
        },
      ],
    });
  });

  it("rejects the entire rendering when a sentence cites an unknown fact", () => {
    const request = prepared();

    expect(() =>
      validateChangeOverviewRendering(request.manifest, {
        sentences: [
          {
            text: "The retained change modifies 2 files.",
            sourceFactIds: ["invented_fact"],
          },
        ],
      }),
    ).toThrow(ChangeOverviewRenderingValidationError);
  });

  it("rejects material literals that do not occur in the cited facts", () => {
    const request = prepared();

    expect(() =>
      validateChangeOverviewRendering(request.manifest, {
        sentences: [
          {
            text: "The retained change modifies 17 files.",
            sourceFactIds: ["file_statistics"],
          },
        ],
      }),
    ).toThrow(ChangeOverviewRenderingValidationError);
  });

  it.each([
    {
      text: `The exact head is ${sha("c")}.`,
      sourceFactIds: ["exact_revision"],
    },
    {
      text: "The retained change adds 2 files.",
      sourceFactIds: ["file_statistics"],
    },
    {
      text: "The retained change adds `src/change-0.ts`.",
      sourceFactIds: ["changed_file_001"],
    },
    {
      text: "The source has 2 commits.",
      sourceFactIds: ["file_statistics"],
    },
  ])("rejects a proposition that contradicts its cited fact: $text", (sentence) => {
    const request = prepared();

    expect(() =>
      validateChangeOverviewRendering(request.manifest, { sentences: [sentence] }),
    ).toThrow(ChangeOverviewRenderingValidationError);
  });

  it("rejects unsupported qualitative wording even when it cites a real fact", () => {
    const request = prepared();

    expect(() =>
      validateChangeOverviewRendering(request.manifest, {
        sentences: [
          {
            text: "The retained change is wonderful.",
            sourceFactIds: ["file_statistics"],
          },
        ],
      }),
    ).toThrow(ChangeOverviewRenderingValidationError);
  });

  it.each([
    "The change prevents unauthorized access.",
    "The change has low risk.",
    "The implementation behaves correctly.",
    "The verdict is positive.",
  ])("rejects behavioral, risk, or verdict language: %s", (text) => {
    const request = prepared();

    expect(() =>
      validateChangeOverviewRendering(request.manifest, {
        sentences: [{ text, sourceFactIds: ["file_statistics"] }],
      }),
    ).toThrow(ChangeOverviewRenderingValidationError);
  });
});
