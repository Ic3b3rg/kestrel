import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FactoryIssueImportsSchema,
  FactoryIssuePublicationSchema,
  FactoryGitHubIssuesSchema,
  FeaturePlanDocumentSchema,
  FeaturePlanVersionSchema,
  FactoryBoardSchema,
  FeatureSchema,
  LocalRepositoryInventorySchema,
  ProjectUpsertedSchema,
} from "@kestrel/contracts";
import { startStack, type RunningStack } from "./support/compose.js";
import { createGitFixture } from "./support/git-fixture.js";
import { factoryGitHubFixture } from "./support/factory-github-fixture.js";

function featurePlan(importedIssueId: string | null = null, pair = true) {
  const plan = FeaturePlanDocumentSchema.parse({
    objective: "Export saved notes",
    scope: { includes: ["Markdown export"], excludes: ["Sharing"] },
    acceptance: [{ key: "download", outcome: "Unicode survives the downloaded file" }],
    workItems: [
      {
        key: "export",
        title: "Export notes",
        description: "Download saved notes as Markdown.",
        importedIssueId,
        requirementKeys: ["download"],
        acceptance: ["Unicode is preserved"],
        dependsOn: [],
        verification: [
          { program: "node", args: ["--test", "export.test.mjs"], cwd: ".", timeoutSeconds: 60 },
        ],
      },
    ],
    limits: {
      maxConcurrentProjects: 2,
      maxActiveFeaturesPerProject: 1,
      attemptTimeoutSeconds: 1800,
    },
  });
  const first = plan.workItems[0];
  if (first === undefined) throw new Error("Work Item fixture missing");
  if (pair)
    plan.workItems.push({
      ...first,
      key: "restore",
      title: "Restore export",
      importedIssueId: null,
      dependsOn: ["export"],
    });
  return plan;
}

interface ProviderFixtureState {
  issues: Array<{ id: string; number: number; title: string; body: string; state: string }>;
  comments: Array<{ id: string; number: number; body: string }>;
  edges: Array<{ number: number; id: string }>;
  calls: Array<{ method: string; endpoint: string; input: unknown }>;
}

describe("Factory GitHub issue authority", () => {
  let stack: RunningStack;
  let projectId: string;
  const cleanup: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    const fixture = await createGitFixture();
    cleanup.push(() => fixture.close());
    stack = await startStack({
      repositoryRoot: fixture.rootPath,
      githubFixture: factoryGitHubFixture,
    });
    cleanup.push(() => stack.close());
    await stack.authenticateOperator();
    const inventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const repository = inventory.repositories.find(({ displayName }) => displayName === "kestrel");
    if (repository === undefined) throw new Error("Fixture source missing");
    const opened = await post("/api/v1/projects/local", { repositoryId: repository.repositoryId });
    projectId = ProjectUpsertedSchema.parse(await opened.json()).project.id;
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
  async function featurePath(title: string) {
    const response = await post(`/api/v1/projects/${projectId}/features`, {
      requestId: randomUUID(),
      title,
    });
    expect(response.status).toBe(201);
    const feature = FeatureSchema.parse(await response.json());
    return `/api/v1/projects/${projectId}/features/${feature.id}`;
  }
  async function providerState(): Promise<ProviderFixtureState> {
    return JSON.parse(
      await stack.executeWebModule(
        `import { readFile } from 'node:fs/promises'; console.log(await readFile('/tmp/kestrel-factory-github.json','utf8'));`,
      ),
    ) as ProviderFixtureState;
  }
  async function controls(value: Record<string, boolean>) {
    await stack.executeWebModule(
      `import { readFile, writeFile } from 'node:fs/promises'; const path='/tmp/kestrel-factory-github.json'; const state=JSON.parse(await readFile(path,'utf8')); state.controls=${JSON.stringify(value)}; await writeFile(path,JSON.stringify(state));`,
    );
  }
  async function publication(path: string) {
    return FactoryIssuePublicationSchema.parse(
      await (await stack.fetchApi(`${path}/publication`)).json(),
    );
  }
  async function waitForPublication(path: string, state: string) {
    await expect
      .poll(async () => (await publication(path)).state, { timeout: 25_000, interval: 250 })
      .toBe(state);
    return publication(path);
  }
  async function approve(path: string, plan = featurePlan(null, false)) {
    const saved = await post(`${path}/plans`, {
      requestId: randomUUID(),
      expectedVersion: null,
      plan,
    });
    expect(saved.status, await saved.clone().text()).toBe(201);
    const response = await post(`${path}/plans/1/approve`, { requestId: randomUUID() });
    expect(response.status, await response.clone().text()).toBe(200);
    return FactoryBoardSchema.parse(await response.json());
  }
  it("exposes durable issue imports and cannot publish before exact plan approval", async () => {
    const path = await featurePath("Review issue context");
    const imported = await stack.fetchApi(`${path}/imports`);
    expect(imported.status, await imported.clone().text()).toBe(200);
    expect(FactoryIssueImportsSchema.parse(await imported.json())).toMatchObject({
      canImport: true,
      issues: [],
    });
    const publication = await stack.fetchApi(`${path}/publication`);
    expect(publication.status).toBe(200);
    expect(FactoryIssuePublicationSchema.parse(await publication.json())).toMatchObject({
      state: "not_approved",
      items: [],
    });
    expect((await post(`${path}/publication`, { requestId: randomUUID() })).status).toBe(409);
  });

  it("imports explicit snapshots, binds approved items once and retains partial publication across restart", async () => {
    const listed = await stack.fetchApi(`/api/v1/projects/${projectId}/github-issues?page=1`);
    expect(listed.status).toBe(200);
    const source = FactoryGitHubIssuesSchema.parse(await listed.json());
    expect(source).toMatchObject({ state: "available", repository: { id: "424242" }, page: 1 });
    expect(source.issues.map(({ number }) => number)).toContain(12);
    expect(
      (await stack.fetchApi(`/api/v1/projects/${projectId}/github-issues?page=6`)).status,
    ).toBe(400);
    const path = await featurePath("Imported export with a new dependent issue");
    const command = { requestId: randomUUID(), issueNumbers: [12] };
    const [first, duplicate] = await Promise.all([
      post(`${path}/imports`, command),
      post(`${path}/imports`, command),
    ]);
    expect(first.status, await first.clone().text()).toBe(201);
    const imported = FactoryIssueImportsSchema.parse(await first.json());
    expect(FactoryIssueImportsSchema.parse(await duplicate.json()).issues).toEqual(imported.issues);
    const snapshot = imported.issues[0];
    if (snapshot === undefined) throw new Error("Imported issue fixture missing");
    expect(snapshot.issue.body).toContain("Original source context 12");
    const other = await featurePath("Do not steal an imported issue");
    expect(
      (await post(`${other}/imports`, { requestId: randomUUID(), issueNumbers: [12] })).status,
    ).toBe(409);
    const unbound = await post(`${path}/plans`, {
      requestId: randomUUID(),
      expectedVersion: null,
      plan: featurePlan(),
    });
    expect(unbound.status).toBe(201);
    expect((await post(`${path}/plans/1/approve`, { requestId: randomUUID() })).status).toBe(400);
    const saved = await post(`${path}/plans`, {
      requestId: randomUUID(),
      expectedVersion: 1,
      plan: featurePlan(snapshot.id),
    });
    expect(saved.status).toBe(201);
    expect(FeaturePlanVersionSchema.parse(await saved.json()).planMarkdown).toContain(
      snapshot.issue.url,
    );
    expect(
      (await post(`${path}/imports`, { requestId: randomUUID(), issueNumbers: [13] })).status,
    ).toBe(409);
    await controls({ rejectCreate: true });
    expect((await post(`${path}/plans/2/approve`, { requestId: randomUUID() })).status).toBe(200);
    const blocked = await waitForPublication(path, "blocked");
    expect(blocked.items[0]).toMatchObject({ state: "published", issue: { number: 12 } });
    expect(blocked.items[1]).toMatchObject({
      state: "blocked",
      failure: "needs_authentication",
      issue: null,
    });
    const before = await providerState();
    expect(before.issues.find(({ number }) => number === 12)?.body).toBe(snapshot.issue.body);
    expect(before.comments.filter(({ number }) => number === 12)).toHaveLength(1);
    await stack.restart("web");
    expect((await publication(path)).items[0]).toEqual(blocked.items[0]);
    const retry = { requestId: randomUUID() };
    expect((await post(`${path}/publication`, retry)).status).toBe(202);
    expect((await post(`${path}/publication`, retry)).status).toBe(202);
    const published = await waitForPublication(path, "published");
    const newNumber = published.items[1]?.issue?.number;
    expect(newNumber).toBeDefined();
    const final = await providerState();
    expect(final.issues.filter(({ number }) => number === newNumber)).toHaveLength(1);
    expect(
      final.edges.filter((edge) => edge.number === newNumber && edge.id === snapshot.issue.id),
    ).toHaveLength(1);
    expect(final.comments.filter(({ number }) => number === newNumber)[0]?.body).toContain(
      snapshot.issue.url,
    );
    expect(final.issues.every(({ state }) => state === "open")).toBe(true);
    expect(
      final.calls.some(
        ({ method, endpoint }) => method === "PATCH" && /\/issues\/[0-9]+$/u.test(endpoint),
      ),
    ).toBe(false);
    const board = FactoryBoardSchema.parse(await (await stack.fetchApi(`${path}/board`)).json());
    expect(board.columns[0]?.items[0]).toMatchObject({
      providerUrl: snapshot.issue.url,
      blocking: { kind: "execution_unavailable" },
    });
    expect(board.columns[3]?.items).toEqual([]);
  }, 60_000);

  it("reconciles an uncertain issue create without another POST even when a scan is empty", async () => {
    const path = await featurePath("Recover an uncertain issue create");
    await controls({ uncertainCreate: true, hideCreated: true });
    await approve(path);
    const blocked = await waitForPublication(path, "blocked");
    expect(blocked.items[0]).toMatchObject({ state: "reconciling", failure: "uncertain_write" });
    const before = await providerState();
    const posts = () =>
      before.calls.filter(
        ({ method, endpoint }) => method === "POST" && /\/issues$/u.test(endpoint),
      ).length;
    await post(`${path}/publication`, { requestId: randomUUID() });
    await waitForPublication(path, "blocked");
    const emptyScan = await providerState();
    expect(
      emptyScan.calls.filter(
        ({ method, endpoint }) => method === "POST" && /\/issues$/u.test(endpoint),
      ),
    ).toHaveLength(posts());
    await controls({});
    await stack.restart("web");
    await post(`${path}/publication`, { requestId: randomUUID() });
    const recovered = await waitForPublication(path, "published");
    const final = await providerState();
    expect(
      final.calls.filter(
        ({ method, endpoint }) => method === "POST" && /\/issues$/u.test(endpoint),
      ),
    ).toHaveLength(posts());
    expect(recovered.items[0]?.issue).not.toBeNull();
  }, 60_000);

  it("reconciles an uncertain comment while preserving its already-created issue", async () => {
    const path = await featurePath("Recover an uncertain progress comment");
    await controls({ uncertainComment: true });
    await approve(path);
    const blocked = await waitForPublication(path, "blocked");
    expect(blocked.items[0]?.issue).not.toBeNull();
    const before = await providerState();
    await post(`${path}/publication`, { requestId: randomUUID() });
    await waitForPublication(path, "published");
    const final = await providerState();
    expect(final.issues).toEqual(before.issues);
    expect(final.comments).toEqual(before.comments);
  }, 45_000);
});
