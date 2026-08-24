import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { generatedArtifacts } from "./openapi.js";

describe("generated public contracts", () => {
  for (const [name, expected] of Object.entries(generatedArtifacts)) {
    it(`${name} matches its authored Zod source`, async () => {
      const artifactUrl = new URL(`../generated/${name}`, import.meta.url);
      await expect(readFile(artifactUrl, "utf8")).resolves.toBe(expected);
    });
  }
});
