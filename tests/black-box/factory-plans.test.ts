import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FeaturePlanVersionSchema,
  FeaturePlansSchema,
  FeatureSchema,
  FactoryBoardSchema,
  LocalRepositoryInventorySchema,
  ProjectUpsertedSchema,
  type FeaturePlanDocument,
} from "@kestrel/contracts";

import { startStack, type RunningStack } from "./support/compose.js";
import { createGitFixture } from "./support/git-fixture.js";

const plan: FeaturePlanDocument = {
  objective: "Save and restore named searches",
  scope: { includes: ["Named searches"], excludes: ["Sharing searches"] },
  acceptance: [
    { key: "saved-search", outcome: "A saved search restores its filters after reload" },
  ],
  workItems: [
    {
      key: "save",
      title: "Save a named search",
      description: "Persist the current filters under a name.",
      requirementKeys: ["saved-search"],
      acceptance: ["Reload retains the name and filters"],
      dependsOn: [],
      verification: [
        { program: "node", args: ["--test", "tests/save.test.mjs"], cwd: ".", timeoutSeconds: 60 },
      ],
    },
    {
      key: "restore",
      title: "Restore a saved search",
      description: "Choose a saved search to restore filters.",
      requirementKeys: ["saved-search"],
      acceptance: ["Restored filters match the saved filters"],
      dependsOn: ["save"],
      verification: [
        {
          program: "node",
          args: ["--test", "tests/restore.test.mjs"],
          cwd: ".",
          timeoutSeconds: 60,
        },
      ],
    },
  ],
  limits: { maxConcurrentProjects: 2, maxActiveFeaturesPerProject: 1, attemptTimeoutSeconds: 1800 },
};

describe("versioned Factory plans", () => {
  let stack: RunningStack;
  let projectId: string;
  const cleanup: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    const fixture = await createGitFixture();
    cleanup.push(() => fixture.close());
    stack = await startStack({ repositoryRoot: fixture.rootPath });
    cleanup.push(() => stack.close());
    await stack.authenticateOperator();
    const inventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const source = inventory.repositories.find(({ displayName }) => displayName === "kestrel");
    if (source === undefined) throw new Error("Fixture source missing");
    const created = await post("/api/v1/projects/local", { repositoryId: source.repositoryId });
    projectId = ProjectUpsertedSchema.parse(await created.json()).project.id;
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
  async function featurePath(title: string): Promise<string> {
    const response = await post(`/api/v1/projects/${projectId}/features`, {
      requestId: randomUUID(),
      title,
    });
    expect(response.status).toBe(201);
    const feature = FeatureSchema.parse(await response.json());
    return `/api/v1/projects/${projectId}/features/${feature.id}`;
  }

  it("saves append-only draft versions and rejects an edit from a stale tab", async () => {
    const path = await featurePath("Save searches");
    const empty = await stack.fetchApi(`${path}/plans`);
    expect(empty.status, await empty.clone().text()).toBe(200);
    expect(FeaturePlansSchema.parse(await empty.json())).toMatchObject({
      current: null,
      approval: null,
      versions: [],
    });
    const command = { requestId: randomUUID(), expectedVersion: null, plan };
    const created = await post(`${path}/plans`, command);
    expect(created.status, await created.clone().text()).toBe(201);
    const first = FeaturePlanVersionSchema.parse(await created.json());
    expect(first).toMatchObject({ version: 1, document: plan, author: "operator" });
    expect(first.planMarkdown).toContain(plan.workItems[0]?.title);
    expect(first.specMarkdown).toContain(plan.acceptance[0]?.outcome);
    expect(await (await post(`${path}/plans`, command)).json()).toEqual(first);
    const revised = { ...plan, objective: "Save searches with clear names" };
    const next = await post(`${path}/plans`, {
      requestId: randomUUID(),
      expectedVersion: 1,
      plan: revised,
    });
    expect(next.status).toBe(201);
    expect(FeaturePlanVersionSchema.parse(await next.json())).toMatchObject({
      version: 2,
      document: revised,
    });
    const stale = await post(`${path}/plans`, {
      requestId: randomUUID(),
      expectedVersion: 1,
      plan,
    });
    expect(stale.status).toBe(409);
    expect(await (await stack.fetchApi(`${path}/plans/1`)).json()).toEqual(first);
    const saved = FeaturePlansSchema.parse(await (await stack.fetchApi(`${path}/plans`)).json());
    expect(saved.current?.version).toBe(2);
    expect(saved.versions).toHaveLength(2);
  });

  it("approves one exact version into ordered cards without allowing stale authority or early completion", async () => {
    const path = await featurePath("Approve saved searches");
    await post(`${path}/plans`, { requestId: randomUUID(), expectedVersion: null, plan });
    const next = await post(`${path}/plans`, {
      requestId: randomUUID(),
      expectedVersion: 1,
      plan: { ...plan, objective: "Save clear search names" },
    });
    const version = FeaturePlanVersionSchema.parse(await next.json());
    const stale = await post(`${path}/plans/1/approve`, { requestId: randomUUID() });
    expect(stale.status).toBe(409);
    const requestId = randomUUID();
    const [first, duplicate] = await Promise.all([
      post(`${path}/plans/2/approve`, { requestId }),
      post(`${path}/plans/2/approve`, { requestId }),
    ]);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(duplicate.status).toBe(200);
    const board = FactoryBoardSchema.parse(await first.json());
    expect(await duplicate.json()).toEqual(board);
    expect(board.feature.state).toBe("queued");
    expect(board.approvedVersion).toBe(2);
    expect(board.executionReadiness.reason).toBe("execution_not_available");
    expect(board.columns.map(({ id, items }) => [id, items.length])).toEqual([
      ["todo", 2],
      ["in_progress", 0],
      ["in_review", 0],
      ["completed", 0],
    ]);
    expect(
      board.columns[0]?.items.map(({ key, order, dependsOn }) => ({ key, order, dependsOn })),
    ).toEqual([
      { key: "save", order: 1, dependsOn: [] },
      { key: "restore", order: 2, dependsOn: ["save"] },
    ]);
    expect(board.columns[0]?.items[0]?.blocking?.kind).toBe("execution_unavailable");
    expect(board.columns[0]?.items[1]?.blocking?.kind).toBe("dependency");
    expect(board.columns[0]?.items[0]?.activity).toHaveLength(1);
    const edit = await post(`${path}/plans`, { requestId: randomUUID(), expectedVersion: 2, plan });
    expect(edit.status).toBe(409);
    expect(
      (
        await post(`${path}/messages`, {
          requestId: randomUUID(),
          text: "Change the approved requirements silently",
        })
      ).status,
    ).toBe(409);
    expect(await (await stack.fetchApi(`${path}/plans/2`)).json()).toEqual(version);
    const featureId = board.feature.id;
    await expect(
      stack.executeRuntimeSql(
        `UPDATE factory_plan_versions SET document = '{}' WHERE feature_id = '${featureId}';`,
      ),
    ).rejects.toThrow();
    await expect(
      stack.executeRuntimeSql(
        `UPDATE factory_plan_approvals SET plan_version = 1 WHERE feature_id = '${featureId}';`,
      ),
    ).rejects.toThrow();
    await stack.restart("web");
    expect(await (await stack.fetchApi(`${path}/board`)).json()).toEqual(board);
    const saved = FeaturePlansSchema.parse(await (await stack.fetchApi(`${path}/plans`)).json());
    expect(saved.approval?.version).toBe(2);
  });

  it("cancels only the displayed draft and preserves approved cards when cancellation follows approval", async () => {
    const path = await featurePath("Cancel a feature");
    await post(`${path}/plans`, { requestId: randomUUID(), expectedVersion: null, plan });
    expect(
      (await post(`${path}/cancel`, { requestId: randomUUID(), expectedVersion: null })).status,
    ).toBe(409);
    const requestId = randomUUID();
    const stopped = await post(`${path}/cancel`, { requestId, expectedVersion: 1 });
    expect(stopped.status, await stopped.clone().text()).toBe(200);
    const board = FactoryBoardSchema.parse(await stopped.json());
    expect(board.feature.state).toBe("cancelled");
    expect(board.approvedVersion).toBeNull();
    expect(board.columns.every(({ items }) => items.length === 0)).toBe(true);
    expect(await (await post(`${path}/cancel`, { requestId, expectedVersion: 1 })).json()).toEqual(
      board,
    );
    expect((await post(`${path}/plans/1/approve`, { requestId: randomUUID() })).status).toBe(409);
    expect(
      (await post(`${path}/plans`, { requestId: randomUUID(), expectedVersion: 1, plan })).status,
    ).toBe(409);

    const racing = await featurePath("Approval and cancel race");
    await post(`${racing}/plans`, { requestId: randomUUID(), expectedVersion: null, plan });
    const [approved, cancelled] = await Promise.all([
      post(`${racing}/plans/1/approve`, { requestId: randomUUID() }),
      post(`${racing}/cancel`, { requestId: randomUUID(), expectedVersion: 1 }),
    ]);
    expect([200, 409]).toContain(approved.status);
    expect(cancelled.status).toBe(200);
    const final = FactoryBoardSchema.parse(await (await stack.fetchApi(`${racing}/board`)).json());
    expect(final.feature.state).toBe("cancelled");
    expect(final.columns[3]?.items).toEqual([]);
    expect(final.columns[0]?.items).toHaveLength(approved.status === 200 ? 2 : 0);
    for (const item of final.columns[0]?.items ?? []) expect(item.blocking?.kind).toBe("cancelled");
    expect(final.activity.filter(({ kind }) => kind === "feature_cancelled")).toHaveLength(1);
  });

  it("rolls back approval and all cards when materializing a Work Item fails", async () => {
    const path = await featurePath("Atomic approval");
    await post(`${path}/plans`, { requestId: randomUUID(), expectedVersion: null, plan });
    await stack.executeSql(`
      CREATE FUNCTION fail_factory_item() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.key = 'restore' THEN RAISE EXCEPTION 'test item failure'; END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER fail_factory_item BEFORE INSERT ON factory_work_items
        FOR EACH ROW EXECUTE FUNCTION fail_factory_item();
    `);
    try {
      expect((await post(`${path}/plans/1/approve`, { requestId: randomUUID() })).status).toBe(500);
      const board = FactoryBoardSchema.parse(await (await stack.fetchApi(`${path}/board`)).json());
      expect(board.feature.state).toBe("planning");
      expect(board.approvedVersion).toBeNull();
      expect(board.columns.every(({ items }) => items.length === 0)).toBe(true);
      expect(board.activity.map(({ kind }) => kind)).toEqual(["draft_saved"]);
    } finally {
      await stack.executeSql(
        "DROP TRIGGER fail_factory_item ON factory_work_items; DROP FUNCTION fail_factory_item();",
      );
    }
    expect((await post(`${path}/plans/1/approve`, { requestId: randomUUID() })).status).toBe(200);
  });
});
