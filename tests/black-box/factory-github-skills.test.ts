import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FactoryIssuePublicationSchema,
  FeatureChatSchema,
  FeatureListSchema,
  FeaturePlanningSkillsSchema,
  FeatureSchema,
  GitHubPlanningSkillBundleSchema,
  LocalRepositoryInventorySchema,
  PlanningSkillCatalogSchema,
  PlanningFeatureStartedSchema,
  ProjectUpsertedSchema,
} from "@kestrel/contracts";
import { startStack, type RunningStack } from "./support/compose.js";
import { createGitFixture } from "./support/git-fixture.js";
import {
  createPlanningSkillGitHubFixture,
  DOMAIN_SKILL_PATH,
  readPlanningSkillGitHubState,
  setPlanningSkillGitHubControls,
} from "./support/planning-skill-github-fixture.js";

describe("pinned GitHub planning Skill imports", () => {
  let stack: RunningStack;
  let provider: Awaited<ReturnType<typeof createPlanningSkillGitHubFixture>>;
  let projectId: string;
  const cleanup: Array<() => Promise<void>> = [];
  const endpoint = "/api/v1/planning-skills/github";
  const starter = { kind: "starter", starter: "grilling-starter" };
  const source = {
    kind: "github",
    owner: "mattpocock",
    repository: "skills",
    path: DOMAIN_SKILL_PATH,
    ref: "main",
  };
  const post = (path: string, body: unknown) =>
    stack.fetchApi(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const catalog = async () =>
    PlanningSkillCatalogSchema.parse(
      await (await stack.fetchApi("/api/v1/planning-skills")).json(),
    );
  const calls = async () => (await readPlanningSkillGitHubState(stack)).calls;
  async function featurePath(title: string) {
    const response = await post(`/api/v1/projects/${projectId}/features`, {
      requestId: randomUUID(),
      title,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return `/api/v1/projects/${projectId}/features/${FeatureSchema.parse(await response.json()).id}`;
  }
  beforeAll(async () => {
    const repository = await createGitFixture();
    cleanup.push(() => repository.close());
    provider = await createPlanningSkillGitHubFixture();
    stack = await startStack({
      repositoryRoot: repository.rootPath,
      githubFixture: provider.githubFixture,
    });
    cleanup.push(() => stack.close());
    await stack.authenticateOperator();
    await setPlanningSkillGitHubControls(stack, {});
    const inventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const source = inventory.repositories.find(({ displayName }) => displayName === "kestrel");
    if (source === undefined) throw new Error("The disposable Project source is missing");
    const opened = await post("/api/v1/projects/local", { repositoryId: source.repositoryId });
    expect(opened.status, await opened.clone().text()).toBe(200);
    projectId = ProjectUpsertedSchema.parse(await opened.json()).project.id;
  });
  afterAll(async () => {
    for (const close of cleanup.toReversed()) await close();
  });

  it("rejects unauthenticated, non-CSRF and unsafe-source commands before provider reads", async () => {
    const before = await calls();
    for (const [path, body] of [
      ["preview", starter],
      ["install", { requestId: randomUUID(), digest: "a".repeat(64) }],
    ] as const) {
      const anonymous = await fetch(`${stack.apiUrl}${endpoint}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(anonymous.status).toBe(401);
      await anonymous.arrayBuffer();
      const noCsrf = await fetch(`${stack.apiUrl}${endpoint}/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: stack.sessionCookie,
          Origin: stack.apiUrl,
        },
        body: JSON.stringify(body),
      });
      expect(noCsrf.status).toBe(403);
      await noCsrf.arrayBuffer();
    }
    for (const body of [
      { ...starter, ref: "main" },
      { ...source, path: "/private/skills/SKILL.md" },
      { ...source, path: "../SKILL.md" },
      { ...source, ref: "" },
    ]) {
      const invalid = await post(`${endpoint}/preview`, body);
      expect(invalid.status, await invalid.clone().text()).toBe(400);
      expect(await invalid.text()).not.toContain("/private/skills");
    }
    const unpreviewed = await post(`${endpoint}/install`, {
      requestId: randomUUID(),
      digest: "a".repeat(64),
    });
    expect(unpreviewed.status).toBe(404);
    await unpreviewed.arrayBuffer();
    expect(await calls()).toEqual(before);
  });

  it("fails auth and missing references without retaining selectable partial instructions", async () => {
    const before = await catalog();
    const path = await featurePath("Reject incomplete Skill sources");
    await setPlanningSkillGitHubControls(stack, { auth: true });
    const denied = await post(`${endpoint}/preview`, source);
    expect(denied.status, await denied.clone().text()).toBe(503);
    expect(await denied.text()).toContain("Sign in to GitHub on the host");
    await setPlanningSkillGitHubControls(stack, {});
    const missing = await post(`${endpoint}/preview`, { ...source, ref: "missing-reference" });
    expect(missing.status, await missing.clone().text()).toBe(400);
    expect(await missing.text()).toContain("reference");
    expect(await catalog()).toEqual(before);
    const chat = FeatureChatSchema.parse(await (await stack.fetchApi(path)).json());
    expect(chat.skills).toEqual({ schemaVersion: 1, version: 0, skills: [] });
    expect(chat.turns).toEqual([]);
    const retained = await stack.executeWebModule(
      `import {createPool} from '@kestrel/database'; const pool=createPool(process.env.DATABASE_URL); try { const result=await pool.query("SELECT count(*) FROM factory_planning_skill_versions WHERE bundle->'source'->>'commitId'=$1",[${JSON.stringify(provider.missingReferenceCommit)}]); console.log(result.rows[0].count); } finally { await pool.end(); }`,
    );
    expect(retained.trim()).toBe("0");
  });

  it("previews every exact starter source and license, then requires explicit installation before selection", async () => {
    const beforeCatalog = await catalog();
    const beforeCalls = (await calls()).length;
    const response = await post(`${endpoint}/preview`, starter);
    expect(response.status, await response.clone().text()).toBe(200);
    const preview = GitHubPlanningSkillBundleSchema.parse(await response.json());
    expect(preview.name).toBe("grilling-starter");
    expect(preview.source.commitId).toBe(provider.originalCommit);
    expect(preview.source.requestedRef).toBe(provider.originalCommit);
    expect(preview.files).toHaveLength(10);
    for (const [path, content] of Object.entries(provider.originals))
      expect(preview.files.find((file) => file.path === `sources/${path}`)?.content).toBe(content);
    expect(preview.files.find(({ path }) => path === "SKILL.md")?.content).toContain(
      "Kestrel adaptation",
    );
    const readCalls = (await calls()).slice(beforeCalls);
    expect(readCalls.filter(({ endpoint }) => endpoint.includes("/commits/"))).toHaveLength(1);
    expect(await catalog()).toEqual(beforeCatalog);
    const path = await featurePath("Review the grilling starter");
    const choose = {
      requestId: randomUUID(),
      expectedVersion: 0,
      digests: [preview.contentDigest],
    };
    expect((await post(`${path}/skills`, choose)).status).toBe(409);
    const collection = `/api/v1/projects/${projectId}/features`;
    const beforeFeatures = FeatureListSchema.parse(await (await stack.fetchApi(collection)).json());
    const firstMessage = {
      requestId: randomUUID(),
      text: "Clarify the report requirements.",
      skillDigests: [preview.contentDigest],
    };
    const rejectedStart = await post(`/api/v1/projects/${projectId}/planning`, firstMessage);
    expect(rejectedStart.status, await rejectedStart.clone().text()).toBe(409);
    expect(FeatureListSchema.parse(await (await stack.fetchApi(collection)).json())).toEqual(
      beforeFeatures,
    );
    expect(
      await (
        await stack.fetchApi(`/api/v1/projects/${projectId}/planning/${firstMessage.requestId}`)
      ).json(),
    ).toMatchObject({ feature: null });
    const beforeInstall = await calls();
    const install = await post(`${endpoint}/install`, {
      requestId: randomUUID(),
      digest: preview.contentDigest,
    });
    expect(install.status, await install.clone().text()).toBe(201);
    expect(GitHubPlanningSkillBundleSchema.parse(await install.json())).toEqual(preview);
    expect(await calls()).toEqual(beforeInstall);
    const acceptedStart = await post(`/api/v1/projects/${projectId}/planning`, firstMessage);
    expect(acceptedStart.status, await acceptedStart.clone().text()).toBe(202);
    const started = PlanningFeatureStartedSchema.parse(await acceptedStart.json());
    const duplicateStart = await post(`/api/v1/projects/${projectId}/planning`, firstMessage);
    expect(duplicateStart.status).toBe(202);
    const duplicate = PlanningFeatureStartedSchema.parse(await duplicateStart.json());
    expect([duplicate.feature.id, duplicate.messageId, duplicate.turnId]).toEqual([
      started.feature.id,
      started.messageId,
      started.turnId,
    ]);
    const startedChat = FeatureChatSchema.parse(
      await (await stack.fetchApi(`${collection}/${started.feature.id}`)).json(),
    );
    expect(startedChat.skills?.skills[0]?.contentDigest).toBe(preview.contentDigest);
    const selected = await post(`${path}/skills`, choose);
    expect(selected.status, await selected.clone().text()).toBe(200);
    expect(FeaturePlanningSkillsSchema.parse(await selected.json()).skills[0]?.contentDigest).toBe(
      preview.contentDigest,
    );
    expect(
      FactoryIssuePublicationSchema.parse(
        await (await stack.fetchApi(`${path}/publication`)).json(),
      ).state,
    ).toBe("not_approved");
    expect((await calls()).every(({ method }) => method === "GET")).toBe(true);
  });

  it("keeps the reviewed commit through moving refs, uncertain install replay, catalog updates and restart", async () => {
    await setPlanningSkillGitHubControls(stack, { advanceOnResolve: true });
    const path = await featurePath("Keep the reviewed domain procedure");
    const before = (await calls()).length;
    const response = await post(`${endpoint}/preview`, source);
    expect(response.status, await response.clone().text()).toBe(200);
    const original = GitHubPlanningSkillBundleSchema.parse(await response.json());
    expect(original.source.commitId).toBe(provider.originalCommit);
    expect(original.files.find(({ path }) => path === "CONTEXT-FORMAT.md")?.content).toBe(
      provider.originals["skills/engineering/domain-modeling/CONTEXT-FORMAT.md"],
    );
    expect(
      (await calls()).slice(before).filter(({ endpoint }) => endpoint.endsWith("/commits/main")),
    ).toHaveLength(1);
    expect((await readPlanningSkillGitHubState(stack)).controls.main).toBe("updated");
    await setPlanningSkillGitHubControls(stack, { main: "updated", auth: true });
    const beforeInstall = await calls();
    const command = { requestId: randomUUID(), digest: original.contentDigest };
    const lost = await post(`${endpoint}/install`, command);
    expect(lost.status).toBe(201);
    // Drop the response body after the transaction committed; the caller retries the same command.
    await lost.body?.cancel();
    const replay = await post(`${endpoint}/install`, command);
    expect(replay.status, await replay.clone().text()).toBe(201);
    expect(GitHubPlanningSkillBundleSchema.parse(await replay.json())).toEqual(original);
    expect(await calls()).toEqual(beforeInstall);
    const selection = await post(`${path}/skills`, {
      requestId: randomUUID(),
      expectedVersion: 0,
      digests: [original.contentDigest],
    });
    expect(selection.status).toBe(200);
    await selection.arrayBuffer();
    await setPlanningSkillGitHubControls(stack, { main: "updated" });
    const laterResponse = await post(`${endpoint}/preview`, source);
    expect(laterResponse.status, await laterResponse.clone().text()).toBe(200);
    const later = GitHubPlanningSkillBundleSchema.parse(await laterResponse.json());
    expect(later.source.commitId).toBe(provider.updatedCommit);
    expect(later.contentDigest).not.toBe(original.contentDigest);
    expect(later.files.find(({ path }) => path === "CONTEXT-FORMAT.md")?.content).toContain(
      "Fixture revision two.",
    );
    expect(
      (await post(`${endpoint}/install`, { ...command, digest: later.contentDigest })).status,
    ).toBe(409);
    const update = await post(`${endpoint}/install`, {
      requestId: randomUUID(),
      digest: later.contentDigest,
    });
    expect(update.status).toBe(201);
    await update.arrayBuffer();
    expect(
      GitHubPlanningSkillBundleSchema.parse(
        await (await post(`${endpoint}/install`, command)).json(),
      ),
    ).toEqual(original);
    expect(
      (await catalog()).skills.find(({ name }) => name === "domain-modeling")?.contentDigest,
    ).toBe(later.contentDigest);
    const count = await stack.executeWebModule(
      `import {createPool} from '@kestrel/database'; const pool=createPool(process.env.DATABASE_URL); try { const result=await pool.query('SELECT count(*) FROM factory_planning_skill_installs WHERE request_id=$1',[${JSON.stringify(command.requestId)}]); console.log(result.rows[0].count); } finally { await pool.end(); }`,
    );
    expect(count.trim()).toBe("1");
    await stack.restart("web");
    const retained = GitHubPlanningSkillBundleSchema.parse(
      await (await stack.fetchApi(`/api/v1/planning-skills/${original.contentDigest}`)).json(),
    );
    expect(retained).toEqual(original);
    const chat = FeatureChatSchema.parse(await (await stack.fetchApi(path)).json());
    expect(chat.skills?.skills[0]?.contentDigest).toBe(original.contentDigest);
    expect(chat.feature.state).toBe("planning");
    expect(chat.turns).toEqual([]);
    expect((await calls()).every(({ method }) => method === "GET")).toBe(true);
  }, 60_000);
});
