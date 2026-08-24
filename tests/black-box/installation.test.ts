import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { InstallationSnapshotSchema } from "@kestrel/contracts";

import { startStack, type RunningStack } from "./support/compose.js";

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.json();
}

describe("observable Kestrel Installation", () => {
  let stack: RunningStack | undefined;

  beforeAll(async () => {
    stack = await startStack();
  });

  afterAll(async () => {
    await stack?.close();
  });

  it("exposes the same persisted Installation across a web restart", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;

    const before = InstallationSnapshotSchema.parse(
      await getJson(`${runningStack.apiUrl}/api/v1/installation`),
    );
    await runningStack.restart("web");
    const after = InstallationSnapshotSchema.parse(
      await getJson(`${runningStack.apiUrl}/api/v1/installation`),
    );

    expect(after).toEqual(before);
  }, 60_000);

  it("serves the generated OpenAPI contract", async () => {
    expect(stack).toBeDefined();
    const document = await getJson(`${(stack as RunningStack).apiUrl}/api/v1/openapi.json`);

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
