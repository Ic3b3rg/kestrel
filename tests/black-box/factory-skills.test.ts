import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStack, type RunningStack } from "./support/compose.js";

describe("retained planning Skills", () => {
  let stack: RunningStack | undefined;
  beforeAll(async () => {
    stack = await startStack();
    await stack.authenticateOperator();
  });
  afterAll(async () => {
    await stack?.close();
  });
  it("exposes an authenticated empty catalog and explains an unconfigured host source", async () => {
    if (stack === undefined) throw new Error("Skill fixture is unavailable");
    expect((await fetch(new URL("/api/v1/planning-skills", stack.apiUrl))).status).toBe(401);
    const catalog = await stack.fetchApi("/api/v1/planning-skills");
    expect(catalog.status, await catalog.clone().text()).toBe(200);
    expect(await catalog.json()).toEqual({ schemaVersion: 1, skills: [] });
    const candidates = await stack.fetchApi("/api/v1/planning-skills/candidates");
    expect(candidates.status, await candidates.clone().text()).toBe(200);
    expect(await candidates.json()).toEqual({
      schemaVersion: 1,
      configured: false,
      candidates: [],
    });
  });
});

// The application reads real temporary files through its authorized source boundary.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FeatureChatSchema,
  FeatureSchema,
  FeaturePlanningSkillsSchema,
  PlanningSkillBundleSchema,
  PlanningSkillCandidatesSchema,
  PlanningSkillCatalogSchema,
  PlanningTurnAcceptedSchema,
  LocalRepositoryInventorySchema,
  ProjectUpsertedSchema,
} from "@kestrel/contracts";
import { createGitFixture, type GitFixture } from "./support/git-fixture.js";

describe("installing and using a host Skill", () => {
  let stack: RunningStack | undefined;
  let fixture: GitFixture | undefined;
  let projectId: string;
  let skillFile: string;
  function requireStack(): RunningStack {
    if (stack === undefined) throw new Error("The planning Skill fixture is unavailable");
    return stack;
  }
  let candidateId: string;
  const entry = (version: string) =>
    `---\nname: 3d-recovery\ndescription: Ask about recovery expectations.\n---\nUse the [recovery checklist](references/checklist.md). ${version}\n`;
  const request = (path: string, body: unknown) =>
    requireStack().fetchApi(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  beforeAll(async () => {
    fixture = await createGitFixture();
    const root = join(fixture.rootPath, "planning-skills");
    const directory = join(root, "ask-recovery");
    await mkdir(join(directory, "references"), { recursive: true });
    await mkdir(join(root, "broken"), { recursive: true });
    skillFile = join(directory, "SKILL.md");
    await writeFile(skillFile, entry("Version one."));
    await writeFile(
      join(directory, "references/checklist.md"),
      "Ask what must survive a process restart.\n",
    );
    await writeFile(
      join(root, "broken/SKILL.md"),
      "---\nname: broken\ndescription: A missing reference\n---\nRead [required context](missing.md).\n",
    );
    stack = await startStack({ repositoryRoot: fixture.rootPath, planningSkillRoot: root });
    await requireStack().authenticateOperator();
    const inventory = LocalRepositoryInventorySchema.parse(
      await (await requireStack().fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const repository = inventory.repositories.find((item) => item.displayName === "kestrel");
    if (repository === undefined) throw new Error("Missing disposable Project");
    projectId = ProjectUpsertedSchema.parse(
      await (
        await request("/api/v1/projects/local", { repositoryId: repository.repositoryId })
      ).json(),
    ).project.id;
    const candidates = PlanningSkillCandidatesSchema.parse(
      await (await requireStack().fetchApi("/api/v1/planning-skills/candidates")).json(),
    );
    expect(candidates.configured).toBe(true);
    expect(JSON.stringify(candidates)).not.toContain(fixture.rootPath);
    candidateId =
      candidates.candidates.find((item) => item.label === "ask-recovery")?.candidateId ?? "";
    expect(candidateId).toHaveLength(64);
  });
  afterAll(async () => {
    await stack?.close();
    await fixture?.close();
  });
  it("fails an incomplete import atomically without selecting partial instructions", async () => {
    const candidates = PlanningSkillCandidatesSchema.parse(
      await (await requireStack().fetchApi("/api/v1/planning-skills/candidates")).json(),
    );
    const broken = candidates.candidates.find((item) => item.label === "broken");
    const response = await request("/api/v1/planning-skills/install", {
      requestId: randomUUID(),
      candidateId: broken?.candidateId,
    });
    expect(response.status, await response.clone().text()).toBe(400);
    expect(
      PlanningSkillCatalogSchema.parse(
        await (await requireStack().fetchApi("/api/v1/planning-skills")).json(),
      ).skills,
    ).toEqual([]);
  });
  it("denies rewriting or deleting accepted Skill and plan provenance", async () => {
    await expect(
      requireStack().executeRuntimeSql("DELETE FROM factory_planning_turns WHERE false"),
    ).rejects.toThrow();
    await expect(
      requireStack().executeRuntimeSql(
        "UPDATE factory_plan_versions SET source_context = '{}'::jsonb WHERE false",
      ),
    ).rejects.toThrow();
    await expect(
      requireStack().executeRuntimeSql("DELETE FROM factory_plan_versions WHERE false"),
    ).rejects.toThrow();
  });
  it("freezes accepted turns across catalog updates, selection changes, retries and restart", async () => {
    const install = { requestId: randomUUID(), candidateId };
    const imported = await request("/api/v1/planning-skills/install", install);
    expect(imported.status, await imported.clone().text()).toBe(201);
    const original = PlanningSkillBundleSchema.parse(await imported.json());
    expect(original.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/checklist.md",
    ]);
    const invokedFeature = FeatureSchema.parse(
      await (
        await request(`/api/v1/projects/${projectId}/features`, {
          requestId: randomUUID(),
          title: "Invoke a Skill by name",
        })
      ).json(),
    );
    const invocationPath = `/api/v1/projects/${projectId}/features/${invokedFeature.id}`;
    const invoked = await request(`${invocationPath}/messages`, {
      requestId: randomUUID(),
      text: "/3d-recovery Clarify recovery.",
      skillSelectionVersion: 0,
    });
    expect(invoked.status, await invoked.clone().text()).toBe(202);
    const invocation = FeatureChatSchema.parse(
      await (await requireStack().fetchApi(invocationPath)).json(),
    );
    expect(invocation.turns[0]?.skills?.[0]?.contentDigest).toBe(original.contentDigest);
    const feature = FeatureSchema.parse(
      await (
        await request(`/api/v1/projects/${projectId}/features`, {
          requestId: randomUUID(),
          title: "Retain recovery decisions",
        })
      ).json(),
    );
    const path = `/api/v1/projects/${projectId}/features/${feature.id}`;
    const choose = {
      requestId: randomUUID(),
      expectedVersion: 0,
      digests: [original.contentDigest],
    };
    const selected = FeaturePlanningSkillsSchema.parse(
      await (await request(`${path}/skills`, choose)).json(),
    );
    expect(selected.version).toBe(1);
    expect(await (await request(`${path}/skills`, choose)).json()).toEqual(selected);
    const message = {
      requestId: randomUUID(),
      text: "$3d-recovery Help define the restart behavior.",
      skillSelectionVersion: 1,
    };
    const accepted = await request(`${path}/messages`, message);
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    const turn = PlanningTurnAcceptedSchema.parse(await accepted.json());
    const readChat = async () =>
      FeatureChatSchema.parse(await (await requireStack().fetchApi(path)).json());
    await expect
      .poll(async () => (await readChat()).turns.at(-1)?.state, { timeout: 10_000 })
      .toBe("failed");
    expect((await readChat()).turns[0]?.skills?.[0]?.contentDigest).toBe(original.contentDigest);
    expect((await readChat()).context?.skills?.[0]?.contentDigest).toBe(original.contentDigest);
    await writeFile(skillFile, entry("Version two changes the questions."));
    // The same accepted import request still returns its original bytes.
    expect(
      PlanningSkillBundleSchema.parse(
        await (await request("/api/v1/planning-skills/install", install)).json(),
      ),
    ).toEqual(original);
    const updated = PlanningSkillBundleSchema.parse(
      await (
        await request("/api/v1/planning-skills/install", { requestId: randomUUID(), candidateId })
      ).json(),
    );
    expect(updated.contentDigest).not.toBe(original.contentDigest);
    expect((await readChat()).skills?.skills[0]?.contentDigest).toBe(original.contentDigest);
    const revised = await request(`${path}/skills`, {
      requestId: randomUUID(),
      expectedVersion: 1,
      digests: [updated.contentDigest],
    });
    expect(revised.status, await revised.clone().text()).toBe(200);
    expect(
      (await request(`${path}/messages`, { ...message, skillSelectionVersion: 2 })).status,
    ).toBe(409);
    const retry = await request(`${path}/turns/${turn.turnId}/retry`, { requestId: randomUUID() });
    expect(retry.status, await retry.clone().text()).toBe(202);
    await expect
      .poll(async () => (await readChat()).turns.at(-1)?.state, { timeout: 10_000 })
      .toBe("failed");
    const chat = await readChat();
    expect(chat.skills?.version).toBe(2);
    expect(chat.skills?.skills[0]?.contentDigest).toBe(updated.contentDigest);
    expect(chat.turns.at(-1)?.skills?.[0]?.contentDigest).toBe(original.contentDigest);
    expect(
      PlanningSkillBundleSchema.parse(
        await (
          await requireStack().fetchApi(`/api/v1/planning-skills/${original.contentDigest}`)
        ).json(),
      ),
    ).toEqual(original);
    await requireStack().restart("web");
    expect((await readChat()).turns.at(-1)?.skills?.[0]?.contentDigest).toBe(
      original.contentDigest,
    );
    const missing = await request(`${path}/messages`, {
      requestId: randomUUID(),
      text: "$missing-procedure Continue",
      skillSelectionVersion: 2,
    });
    expect(missing.status).toBe(409);
    expect((await readChat()).messages).toHaveLength(1);
    const selectedRead = await request(`${path}/skills`, {
      requestId: randomUUID(),
      expectedVersion: 1,
      digests: [],
    });
    expect(selectedRead.status).toBe(409);
    await expect(
      requireStack().executeRuntimeSql(
        "UPDATE factory_planning_skill_versions SET bundle = '{}'::jsonb",
      ),
    ).rejects.toThrow();
    await expect(
      requireStack().executeRuntimeSql(
        "UPDATE factory_planning_turns SET skill_digests = '[]'::jsonb",
      ),
    ).rejects.toThrow();
  });
});
