import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitHubPlanningSkillBundle } from "@kestrel/contracts";
import type { DatabasePool } from "@kestrel/database";
import { buildApp } from "../app.js";
import {
  createCsrfToken,
  createSessionToken,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "../session.js";
import { FactoryGitHubSkillBundleError } from "../factory-github-skill-bundles.js";
import type * as GitHubSkillLoader from "../factory-github-skill-bundles.js";

const provider = vi.hoisted(() => ({ load: vi.fn(), starter: vi.fn() }));
vi.mock("../factory-github-skill-bundles.js", async (original) => ({
  ...(await original<typeof GitHubSkillLoader>()),
  loadGitHubSkillBundle: provider.load,
  loadGitHubPlanningStarter: provider.starter,
}));
const actorId = "01900000-0000-7000-8000-000000000001";
const requestId = "01900000-0000-7000-8000-000000000002";
const signingKey = Buffer.alloc(32, 7);
const token = createSessionToken(
  { id: actorId, username: "operator", credentialVersion: "1", sessionGeneration: "1" },
  signingKey,
).token;
const csrf = createCsrfToken(token, signingKey, Buffer.alloc(32, 3));
const headers = {
  cookie: `${SESSION_COOKIE_NAME}=${token}; ${CSRF_COOKIE_NAME}=${csrf}`,
  host: "kestrel.test",
  origin: "https://kestrel.test",
  "x-kestrel-csrf": csrf,
};
const source = {
  kind: "github" as const,
  label: "mattpocock/skills",
  candidateId: "b".repeat(64),
  owner: "mattpocock",
  repository: "skills",
  path: "grilling/SKILL.md",
  requestedRef: "main",
  commitId: "c".repeat(40),
};
const files = [
  { path: ".kestrel/source.json", content: JSON.stringify({ schemaVersion: 1, source }) },
  {
    path: "SKILL.md",
    content: "---\nname: grilling\ndescription: Ask questions.\n---\nAsk one question.",
  },
];
const bundle: GitHubPlanningSkillBundle = {
  name: "grilling",
  description: "Ask questions.",
  source,
  files,
  contentDigest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
};
let app: Awaited<ReturnType<typeof buildApp>>;
let versions: Map<string, unknown>;
let catalog: Map<string, { digest: string; source_candidate_id: string }>;
let installs: Map<string, { candidate_id: string; digest: string }>;
let statements: string[];
beforeEach(async () => {
  versions = new Map();
  catalog = new Map();
  installs = new Map();
  statements = [];
  provider.load.mockReset().mockResolvedValue(bundle);
  provider.starter.mockReset().mockResolvedValue(bundle);
  const query = vi.fn((sql: string, values: unknown[] = []) => {
    const statement = sql.replace(/\s+/gu, " ").trim();
    statements.push(statement);
    const first = String(values[0]);
    if (statement.includes("FROM operators"))
      return {
        rows: [
          {
            id: actorId,
            username: "operator",
            credential_version: "1",
            jwt_signing_generation: "1",
            password_hash: "test",
            created_at: new Date(),
          },
        ],
      };
    if (
      ["BEGIN", "COMMIT", "ROLLBACK"].includes(statement) ||
      statement.includes("pg_advisory_xact_lock")
    )
      return { rows: [], rowCount: 0 };
    if (statement.startsWith("INSERT INTO factory_planning_skill_versions")) {
      if (!versions.has(String(values[0])))
        versions.set(String(values[0]), JSON.parse(String(values[1])) as unknown);
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("SELECT bundle FROM factory_planning_skill_versions"))
      return {
        rows: versions.has(String(values[0])) ? [{ bundle: versions.get(String(values[0])) }] : [],
      };
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
      statement.includes("FROM factory_planning_turns") ||
      statement.includes("FROM factory_planning_skill_installs")
    )
      return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected query: ${statement}`);
  });
  app = await buildApp({
    boss: { send: vi.fn() },
    eventRetentionLimit: 1000,
    logger: false,
    pool: {
      query,
      connect: () => Promise.resolve({ query, release: vi.fn() }),
    } as unknown as DatabasePool,
    sessionSigningKey: signingKey,
  });
});
afterEach(async () => {
  await app.close();
});
const preview = {
  kind: "github",
  owner: source.owner,
  repository: source.repository,
  path: source.path,
  ref: "main",
};

it("previews a full pinned bundle while leaving the catalog and planning authority unchanged", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/planning-skills/github/preview",
    headers,
    payload: preview,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toEqual(bundle);
  expect(versions.get(bundle.contentDigest)).toEqual(bundle);
  const catalog = await app.inject({ method: "GET", url: "/api/v1/planning-skills", headers });
  expect(catalog.json()).toEqual({ schemaVersion: 1, skills: [] });
  const selected = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${actorId}/features/${actorId}/skills`,
    headers,
    payload: { requestId, expectedVersion: 0, digests: [bundle.contentDigest] },
  });
  expect(selected.statusCode).toBe(409);
  expect(
    statements.some((statement) =>
      /INSERT INTO factory_(?:planning_skill_installs|feature_skill_selections)/u.test(statement),
    ),
  ).toBe(false);
});

it("requires Operator authentication and CSRF before reading GitHub or accepting an install", async () => {
  for (const [path, payload] of [
    ["preview", preview],
    ["install", { requestId, digest: bundle.contentDigest }],
  ] as const) {
    const anonymous = await app.inject({
      method: "POST",
      url: `/api/v1/planning-skills/github/${path}`,
      payload,
    });
    expect(anonymous.statusCode).toBe(401);
    const noCsrf = await app.inject({
      method: "POST",
      url: `/api/v1/planning-skills/github/${path}`,
      headers: { cookie: headers.cookie, host: headers.host, origin: headers.origin },
      payload,
    });
    expect(noCsrf.statusCode).toBe(403);
  }
  expect(provider.load).not.toHaveBeenCalled();
  expect(versions.size).toBe(0);
});

it("installs only the retained preview and replays its request without rereading GitHub or retargeting the catalog", async () => {
  const unpreviewed = await app.inject({
    method: "POST",
    url: "/api/v1/planning-skills/github/install",
    headers,
    payload: { requestId, digest: bundle.contentDigest },
  });
  expect(unpreviewed.statusCode).toBe(404);
  const first = await app.inject({
    method: "POST",
    url: "/api/v1/planning-skills/github/preview",
    headers,
    payload: preview,
  });
  expect(first.statusCode).toBe(200);
  const laterSource = { ...source, commitId: "d".repeat(40) };
  const laterFiles = [
    {
      path: ".kestrel/source.json",
      content: JSON.stringify({ schemaVersion: 1, source: laterSource }),
    },
    ...files.slice(1),
  ];
  const later = {
    ...bundle,
    source: laterSource,
    files: laterFiles,
    contentDigest: createHash("sha256").update(JSON.stringify(laterFiles)).digest("hex"),
  };
  provider.load.mockResolvedValueOnce(later);
  const second = await app.inject({
    method: "POST",
    url: "/api/v1/planning-skills/github/preview",
    headers,
    payload: preview,
  });
  expect(second.statusCode).toBe(200);
  const command = { requestId, digest: bundle.contentDigest };
  const installed = await app.inject({
    method: "POST",
    url: "/api/v1/planning-skills/github/install",
    headers,
    payload: command,
  });
  expect(installed.statusCode, installed.body).toBe(201);
  expect(installed.json()).toEqual(bundle);
  const conflict = await app.inject({
    method: "POST",
    url: "/api/v1/planning-skills/github/install",
    headers,
    payload: { ...command, digest: later.contentDigest },
  });
  expect(conflict.statusCode).toBe(409);
  const updated = await app.inject({
    method: "POST",
    url: "/api/v1/planning-skills/github/install",
    headers,
    payload: { requestId: "01900000-0000-7000-8000-000000000003", digest: later.contentDigest },
  });
  expect(updated.statusCode, updated.body).toBe(201);
  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/planning-skills/github/install",
    headers,
    payload: command,
  });
  expect(replay.statusCode).toBe(201);
  expect(replay.json()).toEqual(bundle);
  expect(catalog.get(bundle.name)?.digest).toBe(later.contentDigest);
  expect(installs.size).toBe(2);
  expect(
    statements.filter((statement) =>
      statement.startsWith("INSERT INTO factory_planning_skill_installs"),
    ),
  ).toHaveLength(2);
  expect(provider.load).toHaveBeenCalledTimes(2);
});

it("loads the explicit starter composition when requested", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/planning-skills/github/preview",
    headers,
    payload: { kind: "starter", starter: "grilling-starter" },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(provider.starter).toHaveBeenCalledOnce();
  expect(provider.load).not.toHaveBeenCalled();
  expect(installs.size).toBe(0);
});

it("rejects mixed starter/custom requests and host paths before provider access", async () => {
  for (const payload of [
    { kind: "starter", starter: "grilling-starter", ref: "main" },
    { ...preview, path: "/private/skills/SKILL.md" },
    { ...preview, path: "../skills/SKILL.md" },
    { ...preview, ref: "" },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/planning-skills/github/preview",
      headers,
      payload,
    });
    expect(response.statusCode, response.body).toBe(400);
  }
  expect(provider.load).not.toHaveBeenCalled();
  expect(provider.starter).not.toHaveBeenCalled();
});

it("reports host GitHub authentication separately from the Operator session", async () => {
  provider.load.mockRejectedValue(new FactoryGitHubSkillBundleError("needs_authentication"));
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/planning-skills/github/preview",
    headers,
    payload: preview,
  });
  expect(response.statusCode, response.body).toBe(503);
  expect(response.json()).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(response.body).toContain("GitHub");
  expect(versions.size).toBe(0);
});
