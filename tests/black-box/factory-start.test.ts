import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  FeatureChatSchema,
  FeatureListSchema,
  FeatureSchema,
  LocalRepositoryInventorySchema,
  ProjectUpsertedSchema,
  PlanningFeatureStartedSchema,
} from "@kestrel/contracts";
import { startStack, type RunningStack } from "./support/compose.js";
import { createGitFixture, type GitFixture } from "./support/git-fixture.js";

let stack: RunningStack | undefined;
let fixture: GitFixture | undefined;
let projectId: string;
function running() {
  if (stack === undefined) throw new Error("Planning-start fixture unavailable");
  return stack;
}
const post = (path: string, body: unknown) =>
  running().fetchApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
beforeAll(async () => {
  fixture = await createGitFixture();
  stack = await startStack({ repositoryRoot: fixture.rootPath });
  await stack.authenticateOperator();
  const inventory = LocalRepositoryInventorySchema.parse(
    await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
  );
  projectId = ProjectUpsertedSchema.parse(
    await (
      await post("/api/v1/projects/local", {
        repositoryId: inventory.repositories[0]?.repositoryId,
      })
    ).json(),
  ).project.id;
});
afterAll(async () => {
  await stack?.close();
  await fixture?.close();
});

it("starts exactly one chat and first turn across simultaneous submissions, reload and rename", async () => {
  const collection = `/api/v1/projects/${projectId}/planning`;
  const command = {
    requestId: randomUUID(),
    text: "Help define searching saved reports.",
    skillDigests: [],
  };
  const lookup = `${collection}/${command.requestId}`;
  const initial = await running().fetchApi(lookup);
  expect(initial.status, await initial.clone().text()).toBe(200);
  expect(await initial.json()).toEqual({ schemaVersion: 1, feature: null });
  const responses = await Promise.all([post(collection, command), post(collection, command)]);
  for (const response of responses)
    expect(response.status, await response.clone().text()).toBe(202);
  const first = PlanningFeatureStartedSchema.parse(await responses[0].json());
  const second: unknown = await responses[1].json();
  expect(second).toEqual(first);
  const feature = FeatureSchema.parse(first.feature);
  expect(feature.title).toBe("New plan");
  const path = `/api/v1/projects/${projectId}/features/${feature.id}`;
  const read = async () => FeatureChatSchema.parse(await (await running().fetchApi(path)).json());
  expect((await read()).messages.map(({ content }) => content)).toEqual([command.text]);
  expect((await read()).turns).toHaveLength(1);
  expect((await read()).feature.state).toBe("planning");
  expect((await post(collection, { ...command, text: "A different request" })).status).toBe(409);
  const rename = { requestId: randomUUID(), title: "Saved report search" };
  const renamed = await post(`${path}/title`, rename);
  expect(renamed.status, await renamed.clone().text()).toBe(200);
  expect(FeatureSchema.parse(await renamed.json()).title).toBe(rename.title);
  expect((await post(`${path}/title`, rename)).status).toBe(200);
  expect(
    (await post(`${path}/title`, { ...rename, title: "Overwrite using the same request" })).status,
  ).toBe(409);
  await running().restart("web");
  expect((await read()).feature.title).toBe(rename.title);
  const retry = await post(collection, command);
  expect(retry.status, await retry.clone().text()).toBe(202);
  expect(
    FeatureListSchema.parse(
      await (await running().fetchApi(`/api/v1/projects/${projectId}/features`)).json(),
    ).features,
  ).toHaveLength(1);
  expect(await (await running().fetchApi(lookup)).json()).toMatchObject({
    feature: { id: feature.id, title: rename.title },
  });
});

it("leaves no abandoned Feature when the first prompt or Skill selection is rejected", async () => {
  const path = `/api/v1/projects/${projectId}/planning`;
  const before: unknown = await (
    await running().fetchApi(`/api/v1/projects/${projectId}/features`)
  ).json();
  const invalid = {
    requestId: randomUUID(),
    text: "$missing-skill Plan this change.",
    skillDigests: [],
  };
  expect((await post(path, { ...invalid, text: "   " })).status).toBe(400);
  expect(
    (await post(path, { ...invalid, text: "Plan report search", title: "A mandatory title" }))
      .status,
  ).toBe(400);
  expect((await post(path, invalid)).status).toBe(409);
  expect(await (await running().fetchApi(`${path}/${invalid.requestId}`)).json()).toEqual({
    schemaVersion: 1,
    feature: null,
  });
  expect(await (await running().fetchApi(`/api/v1/projects/${projectId}/features`)).json()).toEqual(
    before,
  );
});

it("retains legacy Feature-creation idempotency after an explicit rename", async () => {
  const collection = `/api/v1/projects/${projectId}/features`;
  const create = { requestId: randomUUID(), title: "Original navigation title" };
  const created = await post(collection, create);
  expect(created.status, await created.clone().text()).toBe(201);
  const feature = FeatureSchema.parse(await created.json());
  const rename = { requestId: randomUUID(), title: "Operator's improved title" };
  expect((await post(`${collection}/${feature.id}/title`, rename)).status).toBe(200);
  const replay = await post(collection, create);
  expect(replay.status, await replay.clone().text()).toBe(201);
  expect(FeatureSchema.parse(await replay.json())).toMatchObject({
    id: feature.id,
    title: rename.title,
  });
  expect((await post(collection, { ...create, title: rename.title })).status).toBe(409);
});
