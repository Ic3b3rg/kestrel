import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { generatedArtifacts } from "./openapi.js";

describe("generated public contracts", () => {
  it("documents the stable issue conversation read", () => {
    const document: unknown = JSON.parse(generatedArtifacts["openapi-v1.json"]);
    expect(document).toMatchObject({
      paths: {
        "/api/v1/projects/{projectId}/board/starts/{id}": {
          get: { operationId: "readProjectIssueStart" },
        },
      },
      components: { schemas: { ProjectIssueStart: { type: "object" } } },
    });
  });
  for (const [name, expected] of Object.entries(generatedArtifacts)) {
    it(`${name} matches its authored Zod source`, async () => {
      const artifactUrl = new URL(`../generated/${name}`, import.meta.url);
      await expect(readFile(artifactUrl, "utf8")).resolves.toBe(expected);
    });
  }
});
