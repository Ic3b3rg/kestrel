import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import {
  ApiErrorSchema,
  InstallationSnapshotSchema,
  ProjectInboxSchema,
  ProjectUpsertedSchema,
} from "@kestrel/contracts";

import { startStack, type RunningStack } from "./support/compose.js";

async function getJson(stack: RunningStack, path: string): Promise<unknown> {
  const response = await stack.fetchApi(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.json();
}

describe("observable Kestrel Installation", () => {
  let stack: RunningStack | undefined;

  beforeAll(async () => {
    stack = await startStack();
    await stack.authenticateOperator();
  });

  afterAll(async () => {
    await stack?.close();
  });

  it("exposes the same persisted Installation across a web restart", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;

    const before = InstallationSnapshotSchema.parse(
      await getJson(runningStack, "/api/v1/installation"),
    );
    await runningStack.restart("web");
    const after = InstallationSnapshotSchema.parse(
      await getJson(runningStack, "/api/v1/installation"),
    );

    expect(after).toEqual(before);
  }, 60_000);

  it("serves the generated OpenAPI contract", async () => {
    expect(stack).toBeDefined();
    const document = await getJson(stack as RunningStack, "/api/v1/openapi.json");

    expect(document).toMatchObject({
      openapi: "3.1.1",
      paths: {
        "/api/v1/events": {},
        "/api/v1/installation": {},
        "/api/v1/installation/diagnostics": {},
      },
    });
  });

  it("serves the production PWA shell with cache-safe boundaries", async () => {
    expect(stack).toBeDefined();
    const apiUrl = (stack as RunningStack).apiUrl;
    const shellResponse = await fetch(apiUrl);
    expect(shellResponse.status).toBe(200);
    expect(shellResponse.headers.get("cache-control")).toBe("no-cache, no-store");
    const shell = await shellResponse.text();
    expect(shell).toContain("<title>Kestrel Installation</title>");

    const assetUrls = [...shell.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/gu)]
      .map((match) => match[1])
      .filter((url): url is string => url !== undefined);
    expect(assetUrls).toHaveLength(2);
    for (const assetUrl of assetUrls) {
      const asset = await fetch(new URL(assetUrl, apiUrl));
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    }

    const manifestResponse = await fetch(`${apiUrl}/manifest.webmanifest`);
    expect(manifestResponse.headers.get("cache-control")).toBe("no-cache, no-store");
    await expect(manifestResponse.json()).resolves.toMatchObject({
      id: "/",
      name: "Kestrel Installation",
      start_url: "/",
    });

    const serviceWorkerResponse = await fetch(`${apiUrl}/sw.js`);
    expect(serviceWorkerResponse.headers.get("cache-control")).toBe("no-cache, no-store");
    const serviceWorker = await serviceWorkerResponse.text();
    expect(serviceWorker).toContain("precacheAndRoute");
    expect(serviceWorker).toContain("/^\\/api\\//");
    expect(serviceWorker).not.toContain("/api/v1/installation");
  });

  it("opens one public GitHub Project idempotently and keeps its inbox durable", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    expect(ProjectInboxSchema.parse(await getJson(runningStack, "/api/v1/projects"))).toEqual({
      schemaVersion: 1,
      projects: [],
    });

    const rejected = await runningStack.fetchApi("/api/v1/projects", {
      body: JSON.stringify({ url: "http://127.0.0.1/internal" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(rejected.status).toBe(400);
    expect(ApiErrorSchema.parse(await rejected.json())).toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(ProjectInboxSchema.parse(await getJson(runningStack, "/api/v1/projects"))).toEqual({
      schemaVersion: 1,
      projects: [],
    });

    const integrationResult = JSON.parse(
      await runningStack.executeWebModule(`
        import {
          createPool,
          readProjectInbox,
          upsertPublicGitHubProject,
        } from "@kestrel/database";
        import { createPublicGitHubReader } from "./apps/web/dist/public-github.js";
        import { createProjectService } from "./apps/web/dist/routes/projects.js";

        const url = "https://github.com/openai/openai-node/pull/1234";
        const apiUrl = "https://api.github.com/repos/openai/openai-node/pulls/1234";
        const requestedTargets = [];
        const reader = createPublicGitHubReader(async (target, init) => {
          requestedTargets.push(String(target));
          if (String(target) !== apiUrl || Object.hasOwn(init.headers, "Authorization")) {
            throw new Error("Public GitHub integration used an unsafe request");
          }
          return Response.json({
            base: {
              ref: "main",
              repo: {
                full_name: "openai/openai-node",
                name: "openai-node",
                node_id: "R_kgDOGx",
                owner: { login: "openai" },
                private: false,
              },
              sha: "${"a".repeat(40)}",
            },
            head: { ref: "provider-observation", sha: "${"b".repeat(40)}" },
            merged: false,
            merged_at: null,
            node_id: "PR_kwDOGx",
            number: 1234,
            state: "open",
            title: "Keep repository access explicit",
            user: { login: "octocat", node_id: "U_kgDOA" },
          });
        });
        const pool = createPool(process.env.DATABASE_URL, "project-black-box", { max: 1 });
        try {
          const actor = await pool.query("SELECT id FROM operators ORDER BY created_at LIMIT 1");
          const actorId = actor.rows[0]?.id;
          if (typeof actorId !== "string") {
            throw new Error("The Project integration test has no Operator");
          }
          const service = createProjectService(reader, {
            readInbox: () => readProjectInbox(pool),
            upsert: (input) => upsertPublicGitHubProject(pool, input),
          });
          const first = await service.openPublicGitHubPullRequest(
            { url },
            { actorId, correlationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce" },
          );
          const second = await service.openPublicGitHubPullRequest(
            { url },
            { actorId, correlationId: "1c14b018-0260-4aa0-a5e9-61d212b948ce" },
          );
          const inbox = await service.readInbox();
          console.log(JSON.stringify({ first, inbox, requestedTargets, second }));
        } finally {
          await pool.end();
        }
      `),
    ) as Record<string, unknown>;

    const first = ProjectUpsertedSchema.parse(integrationResult.first);
    const second = ProjectUpsertedSchema.parse(integrationResult.second);
    expect(integrationResult.requestedTargets).toEqual([
      "https://api.github.com/repos/openai/openai-node/pulls/1234",
      "https://api.github.com/repos/openai/openai-node/pulls/1234",
    ]);
    expect(second.project.id).toBe(first.project.id);
    expect(second.project.changeProposals[0]?.id).toBe(first.project.changeProposals[0]?.id);
    expect(ProjectInboxSchema.parse(integrationResult.inbox)).toMatchObject({
      projects: [
        { id: first.project.id, changeProposals: [{ id: first.project.changeProposals[0]?.id }] },
      ],
    });

    const beforeRestart = ProjectInboxSchema.parse(await getJson(runningStack, "/api/v1/projects"));
    expect(beforeRestart.projects).toHaveLength(1);
    expect(beforeRestart.projects[0]?.changeProposals).toHaveLength(1);
    expect(beforeRestart.projects[0]).toMatchObject({
      providerObservation: { authentication: "none", kind: "public_github", refresh: "manual" },
      repository: { owner: "openai", name: "openai-node" },
      changeProposals: [{ number: 1234 }],
    });
    await runningStack.restart("web");
    expect(ProjectInboxSchema.parse(await getJson(runningStack, "/api/v1/projects"))).toEqual(
      beforeRestart,
    );
  }, 60_000);

  it("backfills a conservative replay floor when upgrading retained schema 002 state", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    const migrations = await Promise.all(
      [
        "001_installation.sql",
        "002_diagnostics_and_events.sql",
        "003_event_replay_metadata.sql",
      ].map((name) =>
        readFile(new URL(`../../packages/database/migrations/${name}`, import.meta.url), "utf8"),
      ),
    );
    const [installationMigration, eventMigration, replayMigration] = migrations;
    if (!installationMigration || !eventMigration || !replayMigration) {
      throw new Error("Expected all Installation migrations");
    }

    await runningStack.executeSql(`
      CREATE SCHEMA kestrel_upgrade_probe;
      SET search_path TO kestrel_upgrade_probe, public;
      ${installationMigration}
      ${eventMigration}
      INSERT INTO diagnostics (
        installation_id, status, correlation_id,
        requested_at, started_at, completed_at
      )
      SELECT id, 'succeeded', '0c14b018-0260-4aa0-a5e9-61d212b948ce',
             '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z'
      FROM installations;
      UPDATE installations
      SET state = 'diagnostic_succeeded',
          current_diagnostic_id = (SELECT id FROM diagnostics),
          revision = 2;
      INSERT INTO installation_events (
        id, event_type, aggregate_id, aggregate_version,
        correlation_id, causation_id, payload
      ) OVERRIDING SYSTEM VALUE
      SELECT 5,
             'installation.diagnostic.succeeded',
             installations.id,
             2,
             diagnostics.correlation_id,
             diagnostics.correlation_id,
             jsonb_build_object(
               'installationId', installations.id,
               'diagnosticId', diagnostics.id
             )
      FROM installations
      CROSS JOIN diagnostics;
      UPDATE event_streams
      SET first_available_event_id = 5,
          latest_event_id = 5;
      ${replayMigration}
      DO $$
      BEGIN
        IF (SELECT retention_floor_event_id FROM event_streams) <> 4 THEN
          RAISE EXCEPTION 'migration did not backfill the retained replay floor';
        END IF;
      END;
      $$;
      DROP SCHEMA kestrel_upgrade_probe CASCADE;
    `);
  });
});
