import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FeatureSchema,
  LocalRepositoryInventorySchema,
  ProjectUpsertedSchema,
} from "@kestrel/contracts";
import { startStack, type RunningStack } from "./support/compose.js";
import { createGitFixture } from "./support/git-fixture.js";
import { factoryGitHubFixture } from "./support/factory-github-fixture.js";

describe("Factory execution authority", () => {
  let stack: RunningStack;
  let projectId: string;
  let featureId: string;
  const cleanup: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    const source = await createGitFixture();
    cleanup.push(() => source.close());
    stack = await startStack({
      repositoryRoot: source.rootPath,
      githubFixture: factoryGitHubFixture,
    });
    cleanup.push(() => stack.close());
    await stack.authenticateOperator();
    const inventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const repository = inventory.repositories.find(({ displayName }) => displayName === "kestrel");
    if (repository === undefined) throw new Error("Fixture repository missing");
    const opened = await post("/api/v1/projects/local", { repositoryId: repository.repositoryId });
    projectId = ProjectUpsertedSchema.parse(await opened.json()).project.id;
    const created = await post(`/api/v1/projects/${projectId}/features`, {
      requestId: randomUUID(),
      title: "Implement a verified greeting",
    });
    featureId = FeatureSchema.parse(await created.json()).id;
  });
  afterAll(async () => {
    for (const close of cleanup.toReversed()) await close();
  });
  function post(path: string, body: unknown) {
    return stack.fetchApi(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("exposes no execution authority or runs before exact plan approval", async () => {
    const response = await stack.fetchApi(
      `/api/v1/projects/${projectId}/features/${featureId}/execution`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      featureId,
      state: "not_approved",
      failure: null,
      question: null,
      revision: null,
      workItems: [],
    });
  });
});
