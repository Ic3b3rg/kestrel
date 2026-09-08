import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { GitHubPlanningSkillBundle } from "@kestrel/contracts";
import {
  installGitHubPlanningSkill,
  listPlanningSkills,
  readPlanningSkillInstall,
  readPlanningSkills,
  retainGitHubPlanningSkill,
  saveFeaturePlanningSkills,
} from "./factory-skills.js";
import type { DatabasePool } from "./pool.js";

const actorId = "01900000-0000-7000-8000-000000000001";
const requestId = "01900000-0000-7000-8000-000000000002";

function bundle(commitId = "a".repeat(40)): GitHubPlanningSkillBundle {
  const source = {
    kind: "github" as const,
    label: "mattpocock/skills",
    candidateId: "b".repeat(64),
    owner: "mattpocock",
    repository: "skills",
    path: "grilling/SKILL.md",
    requestedRef: "main",
    commitId,
  };
  const files = [
    { path: ".kestrel/source.json", content: JSON.stringify({ schemaVersion: 1, source }) },
    {
      path: "SKILL.md",
      content: "---\nname: grilling\ndescription: Ask questions.\n---\nAsk one question.",
    },
  ];
  return {
    name: "grilling",
    description: "Ask questions.",
    source,
    files,
    contentDigest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  };
}

it("replays an installed GitHub version by its exact digest", async () => {
  const retained = bundle();
  const query = vi.fn((statement: string, values: unknown[]) => {
    if (statement.includes("FROM factory_planning_skill_installs")) {
      expect(values).toEqual([actorId, requestId]);
      return {
        rows: [{ candidate_id: retained.source.candidateId, digest: retained.contentDigest }],
      };
    }
    if (statement.includes("FROM factory_planning_skill_versions")) {
      expect(values).toEqual([retained.contentDigest]);
      return { rows: [{ bundle: retained }] };
    }
    throw new Error(`Unexpected query: ${statement}`);
  });
  await expect(
    readPlanningSkillInstall({ query } as unknown as DatabasePool, actorId, {
      requestId,
      digest: retained.contentDigest,
    }),
  ).resolves.toEqual(retained);
});

function database() {
  const versions = new Map<string, GitHubPlanningSkillBundle>();
  const catalog = new Map<string, { digest: string; source_candidate_id: string }>();
  const installs = new Map<string, { candidate_id: string; digest: string }>();
  const statements: string[] = [];
  const query = vi.fn((sql: string, values: unknown[] = []) => {
    const statement = sql.replace(/\s+/gu, " ").trim();
    statements.push(statement);
    const first = String(values[0]);
    if (
      ["BEGIN", "COMMIT", "ROLLBACK"].includes(statement) ||
      statement.includes("pg_advisory_xact_lock")
    )
      return { rows: [], rowCount: 0 };
    if (statement.startsWith("SELECT bundle FROM factory_planning_skill_versions"))
      return { rows: versions.has(first) ? [{ bundle: versions.get(first) }] : [] };
    if (statement.startsWith("INSERT INTO factory_planning_skill_versions")) {
      if (!versions.has(first))
        versions.set(first, JSON.parse(String(values[1])) as GitHubPlanningSkillBundle);
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("SELECT candidate_id, digest FROM factory_planning_skill_installs")) {
      const existing = installs.get(`${first}:${String(values[1])}`);
      return { rows: existing === undefined ? [] : [existing] };
    }
    if (statement.startsWith("INSERT INTO factory_planning_skill_installs")) {
      installs.set(`${first}:${String(values[1])}`, {
        candidate_id: String(values[2]),
        digest: String(values[3]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("SELECT source_candidate_id FROM factory_planning_skill_catalog")) {
      const existing = catalog.get(first);
      return { rows: existing === undefined ? [] : [existing] };
    }
    if (statement.startsWith("SELECT count(*) FROM factory_planning_skill_catalog"))
      return { rows: [{ count: String(catalog.size) }] };
    if (statement.startsWith("INSERT INTO factory_planning_skill_catalog")) {
      catalog.set(first, { digest: String(values[1]), source_candidate_id: String(values[2]) });
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("SELECT version.bundle FROM factory_planning_skill_catalog"))
      return {
        rows: [...catalog.values()].map(({ digest }) => ({ bundle: versions.get(digest) })),
      };
    if (statement.includes("FROM factory_features WHERE"))
      return {
        rows: [{ id: actorId, project_id: actorId, state: "planning", skill_selection_version: 0 }],
      };
    if (
      statement.includes("FROM factory_feature_skill_selections") ||
      statement.includes("FROM factory_planning_turns")
    )
      return { rows: [], rowCount: 0 };
    if (statement.startsWith("SELECT DISTINCT digest FROM factory_planning_skill_installs")) {
      const selected = values[0] as string[];
      return {
        rows: [...new Set([...installs.values()].map(({ digest }) => digest))]
          .filter((digest) => selected.includes(digest))
          .map((digest) => ({ digest })),
      };
    }
    if (
      statement.startsWith("INSERT INTO factory_feature_skill_selections") ||
      statement.startsWith("UPDATE factory_features SET skill_selection_version")
    )
      return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected query: ${statement}`);
  });
  return {
    pool: {
      query,
      connect: () => Promise.resolve({ query, release: vi.fn() }),
    } as unknown as DatabasePool,
    versions,
    catalog,
    installs,
    statements,
  };
}

it("retains a preview without catalog or installation authority, then installs the reviewed commit", async () => {
  const storage = database();
  const first = bundle();
  const later = bundle("c".repeat(40));
  expect(await retainGitHubPlanningSkill(storage.pool, first)).toEqual(first);
  await retainGitHubPlanningSkill(storage.pool, later);
  expect(await listPlanningSkills(storage.pool)).toEqual([]);
  expect(storage.installs.size).toBe(0);
  const command = { requestId, digest: first.contentDigest };
  expect(await installGitHubPlanningSkill(storage.pool, actorId, command)).toEqual(first);
  expect(await installGitHubPlanningSkill(storage.pool, actorId, command)).toEqual(first);
  expect(storage.catalog.get("grilling")?.digest).toBe(first.contentDigest);
  expect(storage.installs.size).toBe(1);
  expect(
    storage.statements.filter((statement) =>
      statement.startsWith("INSERT INTO factory_planning_skill_installs"),
    ),
  ).toHaveLength(1);
  await expect(
    installGitHubPlanningSkill(storage.pool, actorId, { requestId, digest: later.contentDigest }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(storage.catalog.get("grilling")?.digest).toBe(first.contentDigest);
  await installGitHubPlanningSkill(storage.pool, actorId, {
    requestId: "01900000-0000-7000-8000-000000000003",
    digest: later.contentDigest,
  });
  expect(await installGitHubPlanningSkill(storage.pool, actorId, command)).toEqual(first);
  expect(storage.catalog.get("grilling")?.digest).toBe(later.contentDigest);
  expect(storage.installs.size).toBe(2);
  expect(await readPlanningSkills(storage.pool, [first.contentDigest])).toEqual([first]);
  const selection = await saveFeaturePlanningSkills(storage.pool, actorId, actorId, {
    requestId: "01900000-0000-7000-8000-000000000004",
    expectedVersion: 0,
    digests: [first.contentDigest],
  });
  expect(selection.version).toBe(1);
  expect(selection.skills.map(({ contentDigest }) => contentDigest)).toEqual([first.contentDigest]);
});

it("rejects installation before preview and detects changed source attribution or bytes", async () => {
  const storage = database();
  const original = bundle();
  await expect(
    installGitHubPlanningSkill(storage.pool, actorId, {
      requestId,
      digest: original.contentDigest,
    }),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    retainGitHubPlanningSkill(storage.pool, {
      ...original,
      source: { ...original.source, commitId: "d".repeat(40) },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(
    retainGitHubPlanningSkill(storage.pool, {
      ...original,
      files: [...original.files.slice(0, 1), { path: "SKILL.md", content: "Changed instructions" }],
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(storage.versions.size).toBe(0);
  expect(storage.installs.size).toBe(0);
});

it("prevents selecting a preview-only digest as a planning Skill", async () => {
  const storage = database();
  const preview = bundle();
  storage.versions.set(preview.contentDigest, preview);
  await expect(
    saveFeaturePlanningSkills(storage.pool, actorId, actorId, {
      requestId,
      expectedVersion: 0,
      digests: [preview.contentDigest],
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(
    storage.statements.some((statement) =>
      statement.startsWith("INSERT INTO factory_feature_skill_selections"),
    ),
  ).toBe(false);
});
