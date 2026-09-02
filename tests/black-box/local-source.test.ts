import { execFile } from "node:child_process";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ApiErrorSchema,
  ChangeIntentVersionCreatedSchema,
  LocalRepositoryInventorySchema,
  LocalRepositoryReferencesSchema,
  ProjectInboxSchema,
  ProjectUpsertedSchema,
  ReviewRevisionAvailableSchema,
  ReviewPreparationSchema,
  ReviewWorkflowAcceptedSchema,
  type ProjectUpserted,
  type ReviewRevisionAvailable,
} from "@kestrel/contracts";

import { startStack, type RunningStack } from "./support/compose.js";
import {
  createGitFixture,
  LOCAL_SOURCE_COMMAND_CANARY_PATH,
  type GitFixture,
  type MissingPullRequestFixture,
} from "./support/git-fixture.js";

const execFileAsync = promisify(execFile);

const INSERT_UNRESOLVED_CHANGE_INTENT_SQL = `
  WITH source AS (
    SELECT jsonb_build_array(
      jsonb_build_object(
        'id', 'operator_input',
        'kind', 'operator_input',
        'label', 'Operator input',
        'text', $3::text,
        'version', ($2::bigint)::text,
        'provenance', jsonb_build_object('kind', 'operator_input')
      )
    ) AS selected_sources
  )
  INSERT INTO change_intents (
    change_proposal_id,
    version,
    intent_text,
    submitted_by_operator_id,
    objective,
    scope_boundaries,
    acceptance_outcomes,
    selected_sources,
    source_digest,
    resolution_state,
    resolution_issues,
    created_at
  )
  SELECT $1::uuid,
         $2::bigint,
         $3::text,
         $4::uuid,
         $3::text,
         '[]'::jsonb,
         '[]'::jsonb,
         source.selected_sources,
         encode(sha256(convert_to(source.selected_sources::text, 'UTF8')), 'hex'),
         'unresolved',
         '[{"kind":"missing","field":"scope_boundaries"},{"kind":"missing","field":"acceptance_outcomes"}]'::jsonb,
         COALESCE($5::timestamptz, clock_timestamp())
  FROM source
  RETURNING id
`;

async function runFixtureGit(repository: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/git", ["-C", repository, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function retainedFile(
  stack: RunningStack,
  revisionId: string,
  side: "base" | "head",
  path: string,
): Promise<{ code?: string; content?: string }> {
  const source = `
    import { createPool } from '@kestrel/database';
    import { readLocalSourceConfig, readRetainedFile } from '@kestrel/local-source';
    const pool = createPool(process.env.DATABASE_URL, 'kestrel-artifact-test');
    try {
      const result = await pool.query(
        "SELECT artifact_locator, manifest_digest FROM review_revisions WHERE id = $1 AND revision_state = 'available'",
        [${JSON.stringify(revisionId)}]
      );
      const row = result.rows[0];
      if (!row) throw new Error('available revision missing');
      try {
        const content = await readRetainedFile(await readLocalSourceConfig(), {
          artifactLocator: row.artifact_locator,
          manifestDigest: row.manifest_digest,
          side: ${JSON.stringify(side)},
          path: ${JSON.stringify(path)}
        });
        process.stdout.write(JSON.stringify({ content: content.toString('utf8') }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ code: error?.code ?? 'unexpected' }));
      }
    } finally {
      await pool.end();
    }
  `;
  return JSON.parse(await stack.executeWebModule(source)) as { code?: string; content?: string };
}

async function waitForCompletedModelRendering(
  stack: RunningStack,
  projectId: string,
  changeProposalId: string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const inbox = ProjectInboxSchema.parse(await (await stack.fetchApi("/api/v1/projects")).json());
    const overview = inbox.projects
      .find(({ id }) => id === projectId)
      ?.changeProposals.find(({ id }) => id === changeProposalId)?.changeOverview;
    if (
      overview?.state === "ready" &&
      overview.modelRendering.state !== "not_generated" &&
      overview.modelRendering.state !== "queued" &&
      overview.modelRendering.state !== "rendering"
    ) {
      return overview;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Change Overview model rendering");
}

async function observePublicGitHubProject(
  stack: RunningStack,
  input: {
    baseObjectId: string;
    headObjectId: string;
    name: string;
    number: number;
    repositoryProviderId?: string;
    repositorySuffix?: string;
    suffix: string;
    title: string;
  },
): Promise<ProjectUpserted> {
  const observation = {
    repository: {
      providerId:
        input.repositoryProviderId ?? `R_issue90_${input.repositorySuffix ?? input.suffix}`,
      owner: "Ic3b3rg",
      name: input.name,
      canonicalUrl: `https://github.com/Ic3b3rg/${input.name}`,
    },
    proposal: {
      providerId: `PR_issue90_${input.suffix}`,
      number: input.number,
      title: input.title,
      canonicalUrl: `https://github.com/Ic3b3rg/${input.name}/pull/${String(input.number)}`,
      proposalState: "open",
      base: { ref: "main", objectId: input.baseObjectId },
      head: { ref: "review-source", objectId: input.headObjectId },
      author: { providerId: "U_issue90", login: "operator" },
    },
  };
  const result = await stack.executeWebModule(`
    import { createPool, upsertPublicGitHubProject } from '@kestrel/database';
    const pool = createPool(process.env.DATABASE_URL, 'kestrel-provider-enrichment-test');
    try {
      const actor = await pool.query('SELECT id FROM operators ORDER BY created_at LIMIT 1');
      const result = await upsertPublicGitHubProject(pool, {
        actorId: actor.rows[0].id,
        correlationId: '0c14b018-0260-4aa0-a5e9-61d212b948ce',
        observation: ${JSON.stringify(observation)}
      });
      process.stdout.write(JSON.stringify(result));
    } finally {
      await pool.end();
    }
  `);
  return ProjectUpsertedSchema.parse(JSON.parse(result));
}

interface ProviderLockState {
  barrierHolders: number;
  blockedWriters: number;
}

async function readProviderLockState(stack: RunningStack): Promise<ProviderLockState> {
  const output = await stack.executeWebModule(`
    import { createPool } from '@kestrel/database';
    const pool = createPool(process.env.DATABASE_URL, 'kestrel-provider-lock-observer');
    try {
      const result = await pool.query(\`
        SELECT
          count(*) FILTER (
            WHERE application_name = 'kestrel-provider-lock-barrier'
              AND wait_event_type = 'Timeout'
              AND wait_event = 'PgSleep'
          )::int AS "barrierHolders",
          count(*) FILTER (
            WHERE application_name IN ('kestrel-web', 'kestrel-provider-enrichment-test')
              AND wait_event_type = 'Lock'
              AND wait_event = 'advisory'
          )::int AS "blockedWriters"
        FROM pg_stat_activity
      \`);
      process.stdout.write(JSON.stringify(result.rows[0]));
    } finally {
      await pool.end();
    }
  `);
  return JSON.parse(output) as ProviderLockState;
}

async function waitForProviderLockState(
  stack: RunningStack,
  predicate: (state: ProviderLockState) => boolean,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastState: ProviderLockState = { barrierHolders: 0, blockedWriters: 0 };
  while (Date.now() < deadline) {
    lastState = await readProviderLockState(stack);
    if (predicate(lastState)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for provider identity lock state: ${JSON.stringify(lastState)}`,
  );
}

async function holdProviderIdentityLock(stack: RunningStack): Promise<void> {
  await stack.executeWebModule(`
    import { createPool } from '@kestrel/database';
    const pool = createPool(process.env.DATABASE_URL, 'kestrel-provider-lock-barrier', { max: 1 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('kestrel-github-repository:' || lower($1) || '/' || lower($2), 0))",
        ['Ic3b3rg', 'concurrent']
      );
      await client.query('SELECT pg_sleep(12)');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  `);
}

async function exerciseConcurrentRevisionFamilyMove(
  stack: RunningStack,
  mode: "project_alias" | "source",
): Promise<{ blocked: boolean; code: string | null; constraint: string | null }> {
  return JSON.parse(
    await stack.executeWebModule(`
      import { randomBytes, randomUUID } from 'node:crypto';
      import { createPool } from '@kestrel/database';
      const mode = ${JSON.stringify(mode)};
      const pool = createPool(process.env.DATABASE_URL, 'kestrel-revision-family-lock-test');
      const mover = await pool.connect();
      const writer = await pool.connect();
      let moverOpen = false;
      let writerOpen = false;
      try {
        const installation = await pool.query('SELECT id FROM installations LIMIT 1');
        const operator = await pool.query('SELECT id FROM operators ORDER BY created_at, id LIMIT 1');
        const firstProject = await pool.query(
          'INSERT INTO projects (installation_id) VALUES ($1) RETURNING id',
          [installation.rows[0].id]
        );
        const secondProject = await pool.query(
          'INSERT INTO projects (installation_id) VALUES ($1) RETURNING id',
          [installation.rows[0].id]
        );
        let sourceProjectId = firstProject.rows[0].id;
        let aliasId = null;
        if (mode === 'project_alias') {
          const alias = await pool.query(
            'INSERT INTO projects (installation_id, canonical_project_id) VALUES ($1, $2) RETURNING id',
            [installation.rows[0].id, firstProject.rows[0].id]
          );
          aliasId = alias.rows[0].id;
          sourceProjectId = aliasId;
        }
        const proposal = await pool.query(
          "INSERT INTO change_proposals (project_id, proposal_kind, title_snapshot, " +
          "base_ref_snapshot, base_object_id, head_ref_snapshot, head_object_id, observed_at) " +
          "VALUES ($1, 'local', $2, 'refs/heads/main', $3, 'refs/heads/review', $4, NULL) RETURNING id",
          [firstProject.rows[0].id, 'Concurrent revision family test', 'b'.repeat(40), 'c'.repeat(40)]
        );
        const intent = await pool.query(${JSON.stringify(INSERT_UNRESOLVED_CHANGE_INTENT_SQL)}, [
          proposal.rows[0].id,
          1,
          'Verify the locked revision family',
          operator.rows[0].id,
          null
        ]);
        const source = await pool.query(
          "INSERT INTO local_repository_sources (installation_id, project_id, source_identity, " +
          "repository_id, root_id, repository_relative_locator, display_name_snapshot, " +
          "object_format, attachment_state) VALUES ($1, $2, $3, $4, $5, '', $6, 'sha1', 'detached') RETURNING id",
          [
            installation.rows[0].id,
            sourceProjectId,
            randomBytes(32).toString('hex'),
            randomUUID(),
            randomUUID(),
            'concurrent revision source'
          ]
        );

        await mover.query('BEGIN');
        moverOpen = true;
        if (mode === 'project_alias') {
          await mover.query(
            'UPDATE projects SET canonical_project_id = $2 WHERE id = $1',
            [aliasId, secondProject.rows[0].id]
          );
        } else {
          await mover.query(
            'UPDATE local_repository_sources SET project_id = $2 WHERE id = $1',
            [source.rows[0].id, secondProject.rows[0].id]
          );
        }

        await writer.query('BEGIN');
        writerOpen = true;
        const backend = await writer.query('SELECT pg_backend_pid() AS pid');
        const insertion = writer.query(
          "INSERT INTO review_revisions (project_id, change_proposal_id, " +
          "local_repository_source_id, acquisition_change_intent_id, revision_state, " +
          "base_ref_snapshot, base_object_id, head_ref_snapshot, head_object_id, " +
          "object_format, max_bytes, max_objects) " +
          "VALUES ($1, $2, $3, $4, 'acquiring', 'refs/heads/main', $5, " +
          "'refs/heads/review', $6, 'sha1', 1048576, 1000)",
          [
            firstProject.rows[0].id,
            proposal.rows[0].id,
            source.rows[0].id,
            intent.rows[0].id,
            'b'.repeat(40),
            'c'.repeat(40)
          ]
        );
        let blocked = false;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const activity = await pool.query(
            'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
            [backend.rows[0].pid]
          );
          if (activity.rows[0]?.wait_event_type === 'Lock') {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await mover.query('COMMIT');
        moverOpen = false;

        let failure = { code: null, constraint: null };
        try {
          await insertion;
          await writer.query('COMMIT');
          writerOpen = false;
        } catch (error) {
          failure = { code: error?.code ?? null, constraint: error?.constraint ?? null };
          await writer.query('ROLLBACK').catch(() => undefined);
          writerOpen = false;
        }
        process.stdout.write(JSON.stringify({ blocked, ...failure }));
      } finally {
        if (moverOpen) await mover.query('ROLLBACK').catch(() => undefined);
        if (writerOpen) await writer.query('ROLLBACK').catch(() => undefined);
        mover.release();
        writer.release();
        await pool.end();
      }
    `),
  ) as { blocked: boolean; code: string | null; constraint: string | null };
}

describe("exact local Review Revision", () => {
  let fixture: GitFixture | undefined;
  let stack: RunningStack | undefined;
  let beforeFingerprint: string | undefined;
  let available: ReviewRevisionAvailable | undefined;
  let localFirstFixture:
    { baseObjectId: string; headObjectId: string; repositoryPath: string } | undefined;
  let concurrentFixture:
    { baseObjectId: string; headObjectId: string; repositoryPath: string } | undefined;
  let lateRemoteFixture:
    { baseObjectId: string; headObjectId: string; repositoryPath: string } | undefined;
  let nonmatchingFixture:
    { baseObjectId: string; headObjectId: string; repositoryPath: string } | undefined;

  beforeAll(async () => {
    fixture = await createGitFixture();
    localFirstFixture = await fixture.createSibling("local-first");
    concurrentFixture = await fixture.createSibling("concurrent");
    lateRemoteFixture = await fixture.createSibling("late-remote", null);
    nonmatchingFixture = await fixture.createSibling("provider-other-change", "kestrel");
    const rootEscapeFixture = await fixture.createSibling("root-escape");
    await fixture.setCoreWorktree(rootEscapeFixture.repositoryPath, "/workspace");
    beforeFingerprint = await fixture.snapshotSource();
    stack = await startStack({ repositoryRoot: fixture.rootPath });
    await stack.authenticateOperator();
    await stack.executeRuntimeSql(`
      WITH project AS (
        INSERT INTO projects (
          installation_id,
          provider_observation_kind,
          provider,
          provider_repository_id,
          repository_owner_snapshot,
          repository_name_snapshot,
          repository_canonical_url_snapshot
        )
        SELECT id,
               'public_github',
               'github',
               'R_issue90',
               'Ic3b3rg',
               'kestrel',
               'https://github.com/Ic3b3rg/kestrel'
        FROM installations
        RETURNING id
      )
      INSERT INTO change_proposals (
        project_id,
        provider_proposal_id,
        provider_number,
        title_snapshot,
        canonical_url_snapshot,
        proposal_state,
        base_ref_snapshot,
        base_object_id,
        head_ref_snapshot,
        head_object_id,
        author_provider_id,
        author_login_snapshot
      )
      SELECT id,
             'PR_issue90',
             90,
             'Retain a local Review Revision',
             'https://github.com/Ic3b3rg/kestrel/pull/90',
             'open',
             'main',
             '${fixture.baseObjectId}',
             'review-source',
             '${fixture.headObjectId}',
             'U_issue90',
             'operator'
      FROM project;
    `);
  });

  afterAll(async () => {
    if (stack !== undefined) await stack.close();
    if (fixture !== undefined) await fixture.close();
  });

  it("grants the runtime role only the lifecycle privileges each table needs", async () => {
    if (stack === undefined) throw new Error("Local-source stack is unavailable");
    const privileges = JSON.parse(
      await stack.executeWebModule(`
        import { createPool } from '@kestrel/database';
        const pool = createPool(process.env.DATABASE_URL, 'kestrel-privilege-test');
        try {
          const result = await pool.query(
            "SELECT table_name, " +
            "has_table_privilege(current_user, 'public.' || table_name, 'SELECT') AS can_select, " +
            "has_table_privilege(current_user, 'public.' || table_name, 'INSERT') AS can_insert, " +
            "has_table_privilege(current_user, 'public.' || table_name, 'UPDATE') AS can_update, " +
            "has_table_privilege(current_user, 'public.' || table_name, 'DELETE') AS can_delete " +
            "FROM unnest(ARRAY['projects','change_proposals','local_repository_sources'," +
            "'change_intents','change_overview_fact_manifests','change_overview_renderings'," +
            "'review_revisions'," +
            "'review_workflows']) AS table_name ORDER BY table_name"
          );
          process.stdout.write(JSON.stringify(result.rows));
        } finally {
          await pool.end();
        }
      `),
    ) as Array<Record<string, unknown>>;

    expect(privileges).toEqual([
      {
        table_name: "change_intents",
        can_select: true,
        can_insert: true,
        can_update: false,
        can_delete: false,
      },
      {
        table_name: "change_overview_fact_manifests",
        can_select: true,
        can_insert: true,
        can_update: false,
        can_delete: false,
      },
      ...[
        "change_overview_renderings",
        "change_proposals",
        "local_repository_sources",
        "projects",
      ].map((table_name) => ({
        table_name,
        can_select: true,
        can_insert: true,
        can_update: true,
        can_delete: false,
      })),
      ...["review_revisions", "review_workflows"].map((table_name) => ({
        table_name,
        can_select: true,
        can_insert: true,
        can_update: table_name === "review_revisions",
        can_delete: false,
      })),
    ]);
  });

  it("fails visibly when repository metadata points outside the configured root", async () => {
    if (stack === undefined) throw new Error("Local-source stack is unavailable");
    const repositoryId = JSON.parse(
      await stack.executeWebModule(`
        import { discoverResolvedRepositories, readLocalSourceConfig } from '@kestrel/local-source';
        const candidates = await discoverResolvedRepositories(await readLocalSourceConfig());
        const candidate = candidates.find(({ displayName }) => displayName === 'root-escape');
        if (!candidate) throw new Error('Root-escape fixture was not discovered');
        process.stdout.write(JSON.stringify(candidate.repositoryId));
      `),
    ) as string;

    const response = await stack.fetchApi(
      `/api/v1/local-repository-sources/${repositoryId}/references`,
    );
    expect(response.status).toBe(422);
    expect(ApiErrorSchema.parse(await response.json())).toMatchObject({
      code: "SOURCE_CONTAINMENT_VIOLATION",
    });
  });

  it("retains exact committed objects idempotently without changing the source", async () => {
    if (stack === undefined || fixture === undefined || beforeFingerprint === undefined) {
      throw new Error("Local-source stack fixture is unavailable");
    }
    const inventoryResponse = await stack.fetchApi("/api/v1/local-repository-sources");
    expect(inventoryResponse.status).toBe(200);
    const inventory = LocalRepositoryInventorySchema.parse(await inventoryResponse.json());
    expect(inventory.repositories).toHaveLength(5);
    const repository = inventory.repositories.find(({ displayName }) => displayName === "kestrel");
    if (repository === undefined) throw new Error("Repository inventory is empty");
    expect(JSON.stringify(inventory)).not.toContain(fixture.repositoryPath);
    const staleResponse = await stack.fetchApi(
      "/api/v1/local-repository-sources/018f0f89-9a1d-7484-b224-866ef9d69999/references",
    );
    expect(staleResponse.status).toBe(404);
    expect(ApiErrorSchema.parse(await staleResponse.json())).toMatchObject({
      code: "REPOSITORY_NOT_AVAILABLE",
    });

    const referencesResponse = await stack.fetchApi(
      `/api/v1/local-repository-sources/${repository.repositoryId}/references`,
    );
    expect(referencesResponse.status).toBe(200);
    const references = LocalRepositoryReferencesSchema.parse(await referencesResponse.json());
    expect(references.references.find(({ ref }) => ref === "refs/heads/main")?.commitObjectId).toBe(
      fixture.baseObjectId,
    );
    expect(
      references.references.find(({ ref }) => ref === "refs/heads/review-source")?.commitObjectId,
    ).toBe(fixture.headObjectId);

    const command = {
      repositoryId: repository.repositoryId,
      baseRef: "refs/heads/main",
      headRef: "refs/heads/review-source",
      changeIntent: "Review the exact committed authorization boundary",
    };
    const first = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify(command),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (first.status !== 201) {
      throw new Error(
        `Review Revision request failed (${String(first.status)}): ${await first.text()}\n${await stack.logs("web")}`,
      );
    }
    available = ReviewRevisionAvailableSchema.parse(await first.json());
    expect(available.reviewRevision).toMatchObject({
      state: "available",
      base: { objectId: fixture.baseObjectId },
      head: { objectId: fixture.headObjectId },
    });
    expect(available.changeProposal).toMatchObject({
      kind: "provider_observed",
      providerId: "PR_issue90",
    });
    expect(available.changeProposal.changeOverview).toMatchObject({
      state: "ready",
      exactRevision: {
        base: { objectId: fixture.baseObjectId },
        head: { objectId: fixture.headObjectId },
      },
      changeIntent: { text: command.changeIntent, version: 1 },
      providerObservation: { title: "Retain a local Review Revision" },
      sourceFacts: {
        ruleVersion: 1,
        commitStatistics: { baseTreeFileCount: 3, headTreeFileCount: 3 },
        fileStatistics: { added: 0, modified: 1, deleted: 0, total: 1 },
        changedFiles: [{ path: "review.txt", status: "modified" }],
        pathAreas: [{ pathPrefix: null, changedFileCount: 1, samplePaths: ["review.txt"] }],
        warnings: [],
      },
    });
    expect(available.project.changeProposals).toHaveLength(1);
    expect(available.project.providerObservation).toMatchObject({ kind: "public_github" });
    expect(JSON.stringify(available)).not.toContain("artifactLocator");
    expect(JSON.stringify(available)).not.toContain(fixture.repositoryPath);
    const modelFallback = await waitForCompletedModelRendering(
      stack,
      available.project.id,
      available.changeProposal.id,
    );
    expect(modelFallback).toMatchObject({
      state: "ready",
      modelRendering: {
        state: "unavailable",
        reason: "profile_not_configured",
      },
      sourceFacts: {
        changedFiles: [{ path: "review.txt" }],
      },
    });

    await stack.executeSql(
      `DELETE FROM change_overview_fact_manifests WHERE review_revision_id = '${available.reviewRevision.id}'`,
    );
    const preMigrationInbox = ProjectInboxSchema.parse(
      await (await stack.fetchApi("/api/v1/projects")).json(),
    );
    expect(preMigrationInbox.projects[0]?.changeProposals[0]?.changeOverview).toMatchObject({
      state: "unavailable",
      reason: "facts_not_available",
    });

    const repeated = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify(command),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(repeated.status).toBe(200);
    const repeatedAvailable = ReviewRevisionAvailableSchema.parse(await repeated.json());
    expect(repeatedAvailable.reviewRevision.id).toBe(available.reviewRevision.id);
    expect(repeatedAvailable.changeProposal.changeOverview).toMatchObject({
      state: "ready",
      sourceFacts: {
        commitStatistics: { baseTreeFileCount: 3, headTreeFileCount: 3 },
        changedFiles: [{ path: "review.txt", status: "modified" }],
      },
    });
    const aliased = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify({
        ...command,
        baseRef: "refs/tags/base-alias",
        headRef: "refs/tags/head-alias",
        changeIntent: "A later intent must not retarget an available revision",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(aliased.status).toBe(200);
    const aliasedAvailable = ReviewRevisionAvailableSchema.parse(await aliased.json());
    expect(aliasedAvailable.reviewRevision).toMatchObject({
      id: available.reviewRevision.id,
      base: { ref: "refs/heads/main", objectId: fixture.baseObjectId },
      head: { ref: "refs/heads/review-source", objectId: fixture.headObjectId },
    });
    expect(aliasedAvailable.acquisitionChangeIntent.text).toBe(command.changeIntent);
    expect(aliasedAvailable.changeProposal.changeIntent?.text).toBe(
      "A later intent must not retarget an available revision",
    );
    expect(aliasedAvailable.changeProposal.changeIntent?.version).toBe(2);
    expect(aliasedAvailable.changeProposal.changeOverview).toMatchObject({
      state: "ready",
      changeIntent: {
        text: "A later intent must not retarget an available revision",
        version: 2,
      },
      sourceFacts: {
        fileStatistics: { added: 0, modified: 1, deleted: 0, total: 1 },
        changedFiles: [{ path: "review.txt", status: "modified" }],
      },
    });
    expect(aliasedAvailable.project.changeProposals).toHaveLength(1);
    await expect(
      stack.executeRuntimeSql(
        `DELETE FROM review_revisions WHERE id = '${available.reviewRevision.id}'`,
      ),
    ).rejects.toThrow();
    expect(await fixture.snapshotSource()).toBe(beforeFingerprint);
    await expect(
      retainedFile(stack, available.reviewRevision.id, "base", "review.txt"),
    ).resolves.toEqual({ content: "committed base\n" });
    await expect(
      retainedFile(stack, available.reviewRevision.id, "head", "review.txt"),
    ).resolves.toEqual({ content: "committed head\n" });
    for (const path of ["staged-secret.txt", "untracked-secret.txt", "ignored-secret.txt"]) {
      await expect(retainedFile(stack, available.reviewRevision.id, "head", path)).resolves.toEqual(
        {
          code: "path_not_retained",
        },
      );
    }
    const webLogs = await stack.logs("web");
    expect(webLogs).toContain('"event":"review_revision.available"');
    expect(webLogs).toContain('"revisionState":"available"');
    expect(webLogs).toContain('"correlationId":');
    expect(webLogs).not.toContain(fixture.repositoryPath);
    for (const secret of [
      "dirty worktree secret",
      "staged secret",
      "untracked secret",
      "ignored secret",
    ]) {
      expect(webLogs).not.toContain(secret);
    }
  });

  it("renders only fact-grounded latest output and measures Kestrel overhead separately", async () => {
    if (stack === undefined || available === undefined) {
      throw new Error("Change Overview rendering fixture is unavailable");
    }
    const retained = available;
    const fallback = await waitForCompletedModelRendering(
      stack,
      retained.project.id,
      retained.changeProposal.id,
    );
    expect(fallback).toMatchObject({
      state: "ready",
      modelRendering: {
        state: "unavailable",
        reason: "profile_not_configured",
      },
      sourceFacts: {
        fileStatistics: { total: 1 },
        changedFiles: [{ path: "review.txt" }],
      },
    });

    const benchmark = JSON.parse(
      await stack.executeWebModule(`
        import {
          claimChangeOverviewRendering,
          completeChangeOverviewRendering,
          createPool
        } from '@kestrel/database';
        import {
          CHANGE_OVERVIEW_KESTREL_P95_TARGET_MILLISECONDS,
          createChangeOverviewRenderer
        } from './apps/web/dist/change-overview-renderer.js';

        const pool = createPool(
          process.env.DATABASE_URL,
          'kestrel-overview-rendering-black-box'
        );
        const projectId = ${JSON.stringify(retained.project.id)};
        const changeProposalId = ${JSON.stringify(retained.changeProposal.id)};
        const reviewRevisionId = ${JSON.stringify(retained.reviewRevision.id)};
        const exactHeadObjectId = ${JSON.stringify(retained.reviewRevision.head.objectId)};
        const correlationId = '0c14b018-0260-4aa0-a5e9-61d212b948ce';
        const profile = {
          availability: 'available',
          effectiveIdentity: {
            model: {
              expectedResolvedId: 'gpt-test-2026-08-01',
              requestedId: 'gpt-test-2026-08-01',
              versionPolicy: 'pinned'
            },
            openAiProjectId: 'proj_test',
            organizationId: 'org_test'
          },
          limits: {
            maximumAttempts: 1,
            maximumConcurrentRequests: 1,
            maximumCostUsd: '1.00',
            maximumInputTokens: 20000,
            maximumOutputTokens: 4096,
            maximumRequestBytes: 65536,
            requestTimeoutMilliseconds: 60000
          },
          projectId
        };
        const reset = async () => {
          const result = await pool.query(
            "UPDATE change_overview_renderings SET generation_token = uuidv7(), " +
            "rendering_state = 'queued', " +
            "requested_at = clock_timestamp() - interval '25 milliseconds', " +
            "started_at = NULL, completed_at = NULL, provider_request_id = NULL, " +
            "sentences = NULL, failure_reason = NULL, queue_milliseconds = NULL, " +
            "model_milliseconds = NULL, kestrel_milliseconds = NULL, " +
            "total_milliseconds = NULL, updated_at = clock_timestamp() " +
            "WHERE change_proposal_id = $1 RETURNING generation_token",
            [changeProposalId]
          );
          if (result.rowCount !== 1) throw new Error('rendering row missing');
          return result.rows[0].generation_token;
        };
        const jobFor = (generationToken) => ({
          changeProposalId,
          correlationId,
          exactHeadObjectId,
          generationToken,
          projectId,
          reviewRevisionId
        });
        const persistence = {
          claim: (job) => claimChangeOverviewRendering(pool, job),
          complete: (job, outcome) =>
            completeChangeOverviewRendering(pool, job, outcome),
          readProfile: async () => ({
            projectFound: true,
            reference: { credentialHandle: 'cred_test', profile }
          })
        };
        const response = (output) => ({
          body: JSON.stringify({
            model: 'gpt-test-2026-08-01',
            output: [{
              content: [{ text: JSON.stringify(output), type: 'output_text' }]
            }],
            status: 'completed'
          }),
          headers: {
            'openai-organization': 'org_test',
            'openai-version': '2020-10-01',
            'x-request-id': 'req_overview_black_box'
          },
          statusCode: 200
        });
        const renderer = (output) => {
          let simulatedModelMilliseconds = 0;
          return createChangeOverviewRenderer({
            clock: () => performance.now() + simulatedModelMilliseconds,
            credentialStore: { read: async () => 'sk-test-key' },
            persistence,
            transport: {
              send: async () => {
                simulatedModelMilliseconds += 1000;
                return response(output);
              }
            }
          });
        };
        const safeOutput = {
          sentences: [{
            text: 'The exact head is ' + exactHeadObjectId + '.',
            sourceFactIds: ['exact_revision']
          }]
        };

        try {
          const staleToken = await reset();
          const currentToken = await reset();
          const staleResult = await renderer(safeOutput).process(jobFor(staleToken));
          const invalidResult = await renderer({
            sentences: [{
              text: 'The change prevents unauthorized access.',
              sourceFactIds: ['file_statistics']
            }]
          }).process(jobFor(currentToken));
          const invalid = await pool.query(
            'SELECT rendering_state, failure_reason, sentences ' +
            'FROM change_overview_renderings WHERE change_proposal_id = $1',
            [changeProposalId]
          );

          const runs = [];
          for (let index = 0; index < 20; index += 1) {
            const token = await reset();
            const result = await renderer(safeOutput).process(jobFor(token));
            const timing = await pool.query(
              'SELECT kestrel_milliseconds, model_milliseconds ' +
              'FROM change_overview_renderings WHERE change_proposal_id = $1',
              [changeProposalId]
            );
            runs.push({ result, ...timing.rows[0] });
          }
          const ordered = runs
            .map(({ kestrel_milliseconds }) => Number(kestrel_milliseconds))
            .sort((left, right) => left - right);
          const p95 = ordered[Math.ceil(ordered.length * 0.95) - 1];
          process.stdout.write(JSON.stringify({
            invalid: invalid.rows[0],
            invalidResult,
            p95,
            runs,
            staleResult,
            target: CHANGE_OVERVIEW_KESTREL_P95_TARGET_MILLISECONDS
          }));
        } finally {
          await pool.end();
        }
      `),
    ) as {
      invalid: {
        failure_reason: string | null;
        rendering_state: string;
        sentences: unknown;
      };
      invalidResult: string;
      p95: number;
      runs: Array<{
        kestrel_milliseconds: string;
        model_milliseconds: string;
        result: string;
      }>;
      staleResult: string;
      target: number;
    };

    expect(benchmark.staleResult).toBe("superseded");
    expect(benchmark.invalidResult).toBe("unavailable");
    expect(benchmark.invalid).toEqual({
      failure_reason: "invalid_rendering",
      rendering_state: "unavailable",
      sentences: null,
    });
    expect(benchmark.runs).toHaveLength(20);
    expect(benchmark.runs.every(({ result }) => result === "ready")).toBe(true);
    const modelTimings = benchmark.runs.map(({ model_milliseconds }) => Number(model_milliseconds));
    expect(modelTimings.every((milliseconds) => milliseconds >= 1_000)).toBe(true);
    expect(modelTimings.every((milliseconds) => milliseconds < 1_100)).toBe(true);
    expect(benchmark.p95).toBeLessThanOrEqual(benchmark.target);

    const completed = await waitForCompletedModelRendering(
      stack,
      retained.project.id,
      retained.changeProposal.id,
    );
    expect(completed).toMatchObject({
      state: "ready",
      modelRendering: {
        state: "ready",
        sentences: [
          {
            text: `The exact head is ${retained.reviewRevision.head.objectId}.`,
            sourceFactIds: ["exact_revision"],
          },
        ],
      },
      sourceFacts: {
        changedFiles: [{ path: "review.txt" }],
      },
    });
    if (completed.modelRendering.state !== "ready") {
      throw new Error("Measured Change Overview rendering was not ready");
    }
    expect(completed.modelRendering.performance.modelMilliseconds).toBeGreaterThanOrEqual(1_000);
    expect(completed.modelRendering.performance.modelMilliseconds).toBeLessThan(1_100);
    expect(completed.modelRendering.performance.kestrelMilliseconds).toBeLessThanOrEqual(
      benchmark.target,
    );
    expect(JSON.stringify(completed)).not.toMatch(
      /prevents unauthorized|Graph|Evidence|Coverage|Finding|Risk|Verdict/u,
    );
  });

  it("rechecks and freezes a prepared Review digest in one database transaction", async () => {
    if (stack === undefined || available === undefined) {
      throw new Error("Prepared Review integration fixture is unavailable");
    }
    const retained = available;
    const inbox = ProjectInboxSchema.parse(await (await stack.fetchApi("/api/v1/projects")).json());
    const project = inbox.projects.find(({ id }) => id === retained.project.id);
    const proposal = project?.changeProposals.find(({ id }) => id === retained.changeProposal.id);
    if (project === undefined || proposal === undefined) {
      throw new Error("Prepared Review Project is unavailable");
    }
    const intentResponse = await stack.fetchApi(
      `/api/v1/projects/${project.id}/change-proposals/${proposal.id}/change-intents`,
      {
        body: JSON.stringify({
          acceptanceOutcomes: ["Only the exact retained revision is reviewed."],
          expectedProposalVersion: proposal.version,
          objective: "Review the retained authorization boundary.",
          operatorInput: "Review the retained authorization boundary.",
          scopeBoundaries: ["Do not add provider write authority."],
          selectedSourceIds: [],
          unresolvedIssues: [],
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    );
    expect(intentResponse.status).toBe(201);
    const createdIntent = ChangeIntentVersionCreatedSchema.parse(await intentResponse.json());

    const result = JSON.parse(
      await stack.executeWebModule(`
        import {
          createPool,
          readReviewPreparation,
          startReviewWorkflow
        } from '@kestrel/database';
        const pool = createPool(process.env.DATABASE_URL, 'kestrel-review-workflow-test');
        const profile = {
          analysisConfiguration: {
            id: '018f0f89-a45f-79af-8544-650e9f15c211',
            version: 1,
            displayName: 'Direct API review profile',
            modelRoute: 'direct_api',
            digest: '${"d".repeat(64)}'
          },
          modelRouteAvailability: 'available',
          resourceEnvelope: {
            id: 'review-first-v1-default',
            version: 1,
            displayName: 'Review First V1 default envelope',
            limits: {
              maximumMemoryBytes: 1073741824,
              maximumProcesses: 64,
              maximumWritableDiskBytes: 2147483648,
              maximumCpuMillicores: 1000,
              maximumConcurrentAttempts: 1
            },
            terminalBoundary: {
              onExhaustion: 'partial_or_failed',
              requiresUncoveredAreaDisclosure: true
            },
            digest: '${"e".repeat(64)}'
          }
        };
        try {
          const actor = await pool.query('SELECT id FROM operators ORDER BY created_at LIMIT 1');
          const input = {
            actorId: actor.rows[0].id,
            changeProposalId: ${JSON.stringify(proposal.id)},
            projectId: ${JSON.stringify(project.id)}
          };
          const preparation = await readReviewPreparation(pool, input, profile);
          const accepted = await startReviewWorkflow(pool, {
            ...input,
            command: { preparationDigest: preparation.preparationDigest },
            correlationId: '0c14b018-0260-4aa0-a5e9-61d212b948ce'
          }, profile);
          const repeated = await startReviewWorkflow(pool, {
            ...input,
            command: { preparationDigest: preparation.preparationDigest },
            correlationId: '0c14b018-0260-4aa0-a5e9-61d212b948ce'
          }, profile);
          let conflictCode = null;
          try {
            await startReviewWorkflow(pool, {
              ...input,
              command: { preparationDigest: '${"f".repeat(64)}' },
              correlationId: '0c14b018-0260-4aa0-a5e9-61d212b948ce'
            }, profile);
          } catch (error) {
            conflictCode = error?.code ?? null;
          }
          const persisted = await pool.query(
            'SELECT review_revision_id, change_intent_id, input_digest, analysis_configuration, authority, resource_envelope, workflow_state FROM review_workflows WHERE id = $1',
            [accepted.workflow.id]
          );
          const count = await pool.query('SELECT count(*)::int AS count FROM review_workflows');
          const auditCount = await pool.query(
            "SELECT count(*)::int AS count FROM installation_audit_records WHERE event_type = 'review_workflow.started' AND target_id = $1",
            [accepted.workflow.id]
          );
          process.stdout.write(JSON.stringify({
            accepted,
            auditCount: auditCount.rows[0].count,
            conflictCode,
            count: count.rows[0].count,
            persisted: persisted.rows[0],
            preparation,
            repeated
          }));
        } finally {
          await pool.end();
        }
      `),
    ) as {
      accepted: unknown;
      auditCount: number;
      conflictCode: string | null;
      count: number;
      persisted: Record<string, unknown>;
      preparation: unknown;
      repeated: unknown;
    };
    const preparation = ReviewPreparationSchema.parse(result.preparation);
    const accepted = ReviewWorkflowAcceptedSchema.parse(result.accepted);
    const repeated = ReviewWorkflowAcceptedSchema.parse(result.repeated);

    expect(preparation).toMatchObject({
      readiness: "ready",
      blockers: [],
      changeIntent: { id: createdIntent.changeIntent.id },
      reviewRevision: { id: retained.reviewRevision.id },
    });
    expect(accepted.workflow).toMatchObject({
      inputDigest: preparation.preparationDigest,
      state: "queued",
    });
    expect(result.persisted).toMatchObject({
      review_revision_id: retained.reviewRevision.id,
      change_intent_id: createdIntent.changeIntent.id,
      input_digest: preparation.preparationDigest,
      analysis_configuration: accepted.workflow.analysisConfiguration,
      authority: accepted.workflow.authority,
      resource_envelope: accepted.workflow.resourceEnvelope,
      workflow_state: "queued",
    });
    expect(result.conflictCode).toBe("preparation_conflict");
    expect(repeated.workflow.id).toBe(accepted.workflow.id);
    expect(result.auditCount).toBe(1);
    expect(result.count).toBe(1);
    await expect(
      stack.executeSql(`
        UPDATE review_workflows
        SET input_digest = '${"0".repeat(64)}'
        WHERE id = '${accepted.workflow.id}';
      `),
    ).rejects.toThrow();
  });

  async function exerciseAliasedReviewWorkflow(): Promise<void> {
    if (stack === undefined || available === undefined) {
      throw new Error("Aliased Review input fixture is unavailable");
    }
    const retained = available;
    const localSourceId = retained.project.localRepositorySource?.id;
    if (localSourceId === undefined) throw new Error("Local source fixture is unavailable");

    const result = JSON.parse(
      await stack.executeWebModule(`
        import {
          createPool,
          readReviewPreparation,
          startReviewWorkflow
        } from '@kestrel/database';
        const pool = createPool(process.env.DATABASE_URL, 'kestrel-aliased-review-workflow-test');
        const profile = {
          analysisConfiguration: {
            id: '018f0f89-a45f-79af-8544-650e9f15c211',
            version: 1,
            displayName: 'Direct API review profile',
            modelRoute: 'direct_api',
            digest: '${"d".repeat(64)}'
          },
          modelRouteAvailability: 'available',
          resourceEnvelope: {
            id: 'review-first-v1-default',
            version: 1,
            displayName: 'Review First V1 default envelope',
            limits: {
              maximumMemoryBytes: 1073741824,
              maximumProcesses: 64,
              maximumWritableDiskBytes: 2147483648,
              maximumCpuMillicores: 1000,
              maximumConcurrentAttempts: 1
            },
            terminalBoundary: {
              onExhaustion: 'partial_or_failed',
              requiresUncoveredAreaDisclosure: true
            },
            digest: '${"e".repeat(64)}'
          }
        };
        try {
          const actor = await pool.query('SELECT id FROM operators ORDER BY created_at LIMIT 1');
          const alias = await pool.query(
            "INSERT INTO change_proposals (project_id, proposal_kind, " +
            "canonical_change_proposal_id, title_snapshot, base_ref_snapshot, base_object_id, " +
            "head_ref_snapshot, head_object_id, observed_at) " +
            "VALUES ($1, 'alias', $2, 'Aliased retained Review inputs', $3, $4, $5, $6, NULL) " +
            "RETURNING id",
            [
              ${JSON.stringify(retained.project.id)},
              ${JSON.stringify(retained.changeProposal.id)},
              ${JSON.stringify(retained.reviewRevision.base.ref)},
              ${JSON.stringify(retained.reviewRevision.base.objectId)},
              ${JSON.stringify(retained.reviewRevision.head.ref)},
              ${JSON.stringify(retained.reviewRevision.head.objectId)}
            ]
          );
          const intent = await pool.query(
            "INSERT INTO change_intents (change_proposal_id, version, intent_text, " +
            "submitted_by_operator_id, objective, scope_boundaries, acceptance_outcomes, " +
            "selected_sources, source_digest, resolution_state, resolution_issues) " +
            "VALUES ($1, 99, 'Review aliased retained inputs.', $2, " +
            "'Review aliased retained inputs.', $3::jsonb, $4::jsonb, $5::jsonb, $6, " +
            "'resolved', '[]'::jsonb) RETURNING id",
            [
              alias.rows[0].id,
              actor.rows[0].id,
              JSON.stringify(['Keep the alias inside its canonical proposal family.']),
              JSON.stringify(['Freeze the exact aliased revision and intent.']),
              JSON.stringify([{
                id: 'operator_input',
                kind: 'operator_input',
                label: 'Operator input',
                text: 'Review aliased retained inputs.',
                version: '99',
                provenance: { kind: 'operator_input' }
              }]),
              '${"c".repeat(64)}'
            ]
          );
          const revisionIdentity = await pool.query('SELECT uuidv7() AS id');
          const revisionId = revisionIdentity.rows[0].id;
          await pool.query(
            "INSERT INTO review_revisions (id, project_id, change_proposal_id, " +
            "local_repository_source_id, acquisition_change_intent_id, revision_state, " +
            "base_ref_snapshot, base_object_id, head_ref_snapshot, head_object_id, object_format, " +
            "max_bytes, max_objects, object_count, retained_bytes, artifact_locator, " +
            "manifest_digest, available_at) VALUES ($1, $2, $3, $4, $5, 'available', " +
            "$6, $7, $8, $9, 'sha1', 1048576, 1000, 7, 4096, $10, $11, clock_timestamp())",
            [
              revisionId,
              ${JSON.stringify(retained.project.id)},
              alias.rows[0].id,
              ${JSON.stringify(localSourceId)},
              intent.rows[0].id,
              ${JSON.stringify(retained.reviewRevision.base.ref)},
              ${JSON.stringify(retained.reviewRevision.base.objectId)},
              ${JSON.stringify(retained.reviewRevision.head.ref)},
              ${JSON.stringify(retained.reviewRevision.head.objectId)},
              'projects/${retained.project.id}/revisions/' + revisionId,
              '${"a".repeat(64)}'
            ]
          );
          const input = {
            actorId: actor.rows[0].id,
            changeProposalId: ${JSON.stringify(retained.changeProposal.id)},
            projectId: ${JSON.stringify(retained.project.id)}
          };
          const preparation = await readReviewPreparation(pool, input, profile);
          const accepted = await startReviewWorkflow(pool, {
            ...input,
            command: { preparationDigest: preparation.preparationDigest },
            correlationId: '0c14b018-0260-4aa0-a5e9-61d212b948cf'
          }, profile);
          const unrelatedProposal = await pool.query(
            "INSERT INTO change_proposals (project_id, proposal_kind, title_snapshot, " +
            "base_ref_snapshot, base_object_id, head_ref_snapshot, head_object_id, observed_at) " +
            "VALUES ($1, 'local', 'Unrelated Review input family', 'refs/heads/main', $2, " +
            "'refs/heads/review', $3, NULL) RETURNING id",
            [${JSON.stringify(retained.project.id)}, '7'.repeat(40), '8'.repeat(40)]
          );
          const unrelatedIntent = await pool.query(
            "INSERT INTO change_intents (change_proposal_id, version, intent_text, " +
            "submitted_by_operator_id, objective, scope_boundaries, acceptance_outcomes, " +
            "selected_sources, source_digest, resolution_state, resolution_issues) " +
            "VALUES ($1, 1, 'Unrelated Review intent.', $2, 'Unrelated Review intent.', " +
            "$3::jsonb, $4::jsonb, $5::jsonb, $6, 'resolved', '[]'::jsonb) RETURNING id",
            [
              unrelatedProposal.rows[0].id,
              actor.rows[0].id,
              JSON.stringify(['Stay outside the prepared proposal family.']),
              JSON.stringify(['Reject cross-family Review input binding.']),
              JSON.stringify([{
                id: 'operator_input',
                kind: 'operator_input',
                label: 'Operator input',
                text: 'Unrelated Review intent.',
                version: '1',
                provenance: { kind: 'operator_input' }
              }]),
              '${"b".repeat(64)}'
            ]
          );
          let crossFamilyError = { code: null, constraint: null };
          try {
            await pool.query(
              "INSERT INTO review_workflows (project_id, change_proposal_id, " +
              "review_revision_id, change_intent_id, requested_by_operator_id, input_digest, " +
              "analysis_configuration, authority, resource_envelope, workflow_state) " +
              "VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, 'queued')",
              [
                ${JSON.stringify(retained.project.id)},
                ${JSON.stringify(retained.changeProposal.id)},
                revisionId,
                unrelatedIntent.rows[0].id,
                actor.rows[0].id,
                '${"9".repeat(64)}',
                JSON.stringify(profile.analysisConfiguration),
                JSON.stringify({
                  action: 'start_review',
                  operatorId: actor.rows[0].id,
                  state: 'available'
                }),
                JSON.stringify(profile.resourceEnvelope)
              ]
            );
          } catch (error) {
            crossFamilyError = {
              code: error?.code ?? null,
              constraint: error?.constraint ?? null
            };
          }
          const persisted = await pool.query(
            'SELECT change_proposal_id, review_revision_id, change_intent_id ' +
            'FROM review_workflows WHERE id = $1',
            [accepted.workflow.id]
          );
          process.stdout.write(JSON.stringify({
            accepted,
            aliasId: alias.rows[0].id,
            crossFamilyError,
            intentId: intent.rows[0].id,
            persisted: persisted.rows[0],
            preparation,
            revisionId
          }));
        } finally {
          await pool.end();
        }
      `),
    ) as {
      accepted: unknown;
      aliasId: string;
      crossFamilyError: { code: string | null; constraint: string | null };
      intentId: string;
      persisted: Record<string, unknown>;
      preparation: unknown;
      revisionId: string;
    };
    const preparation = ReviewPreparationSchema.parse(result.preparation);
    const accepted = ReviewWorkflowAcceptedSchema.parse(result.accepted);

    expect(preparation).toMatchObject({
      changeProposalId: retained.changeProposal.id,
      reviewRevision: { id: result.revisionId },
      changeIntent: { id: result.intentId },
      readiness: "ready",
    });
    expect(accepted.workflow).toMatchObject({
      changeProposalId: retained.changeProposal.id,
      reviewRevisionId: result.revisionId,
      changeIntentId: result.intentId,
    });
    expect(result.persisted).toEqual({
      change_proposal_id: retained.changeProposal.id,
      review_revision_id: result.revisionId,
      change_intent_id: result.intentId,
    });
    expect(result.crossFamilyError).toEqual({
      code: "23514",
      constraint: "review_workflows_input_proposal_family",
    });
  }

  it("uses only the recorded Git allowlist and never invokes repository commands", async () => {
    if (stack === undefined) throw new Error("Local-source stack is unavailable");
    const boundary = JSON.parse(
      await stack.executeWebModule(`
        import { lstat, readFile } from 'node:fs/promises';
        const commands = (await readFile('/tmp/kestrel-git-commands.log', 'utf8'))
          .split(/\\r?\\n/u)
          .filter(Boolean);
        const environment = await readFile('/tmp/kestrel-git-environment.log', 'utf8');
        const canaryInvoked = await lstat(${JSON.stringify(LOCAL_SOURCE_COMMAND_CANARY_PATH)})
          .then(() => true)
          .catch((error) => {
            if (error?.code === 'ENOENT') return false;
            throw error;
          });
        process.stdout.write(JSON.stringify({ canaryInvoked, commands, environment }));
      `),
    ) as { canaryInvoked: boolean; commands: string[]; environment: string };
    const allowedSuffixes = [
      "cat-file --batch",
      "config --local --no-includes --get-regexp ^remote\\..*\\.url$",
      "for-each-ref --count=501 --sort=refname --format=%(refname)%00%(objectname) refs/heads refs/remotes refs/tags",
      "rev-parse --absolute-git-dir",
      "rev-parse --is-bare-repository",
      "rev-parse --path-format=absolute --git-common-dir",
      "rev-parse --path-format=absolute --git-path objects",
      "rev-parse --show-object-format=storage",
      "rev-parse --show-toplevel",
      "rev-parse --verify --end-of-options HEAD",
    ];
    const observedSuffixes: string[] = [];
    for (const command of boundary.commands) {
      if (command === "--version") continue;
      const match =
        /^--no-lazy-fetch -c safe\.directory=(\/fixtures\/repositories\/\S+) -C \1 (.+)$/u.exec(
          command,
        );
      expect(match, `unexpected Git argument vector: ${command}`).not.toBeNull();
      if (match?.[2] !== undefined) observedSuffixes.push(match[2]);
    }
    expect([...new Set(observedSuffixes)].sort()).toEqual(allowedSuffixes.sort());
    for (const value of [
      "GIT_CONFIG_GLOBAL=/dev/null",
      "GIT_CONFIG_NOSYSTEM=1",
      "GIT_CONFIG_SYSTEM=/dev/null",
      "GIT_NO_LAZY_FETCH=1",
      "GIT_NO_REPLACE_OBJECTS=1",
      "GIT_OPTIONAL_LOCKS=0",
      "GIT_TERMINAL_PROMPT=0",
    ]) {
      expect(boundary.environment).toContain(value);
    }
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GIT_ASKPASS",
      "GIT_SSH",
      "GIT_SSH_COMMAND",
      "HOME",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "SSH_ASKPASS",
      "SSH_AUTH_SOCK",
    ]) {
      expect(boundary.environment).not.toMatch(new RegExp(`^${name}=`, "mu"));
    }
    expect(boundary.environment).not.toContain("provider-client-canary");
    expect(boundary.canaryInvoked).toBe(false);
  });

  it("retains the same exact commits independently for an explicitly selected proposal", async () => {
    if (stack === undefined || fixture === undefined || available === undefined) {
      throw new Error("Same-exact proposal fixture is unavailable");
    }
    const secondProviderProposal = await observePublicGitHubProject(stack, {
      baseObjectId: fixture.baseObjectId,
      headObjectId: fixture.headObjectId,
      name: "kestrel",
      number: 91,
      repositoryProviderId: "R_issue90",
      suffix: "same_exact",
      title: "Retain the same exact source for a second proposal",
    });
    expect(secondProviderProposal.project.id).toBe(available.project.id);
    const selected = secondProviderProposal.project.changeProposals.find(
      (proposal) => "providerId" in proposal && proposal.providerId === "PR_issue90_same_exact",
    );
    if (selected === undefined) throw new Error("Second exact provider proposal is unavailable");

    const inventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const repository = inventory.repositories.find(({ displayName }) => displayName === "kestrel");
    if (repository === undefined) throw new Error("Exact proposal repository is unavailable");
    const response = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify({
        repositoryId: repository.repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/review-source",
        changeProposalId: selected.id,
        changeIntent: "Review the second proposal against its independently retained revision",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(201);
    const retained = ReviewRevisionAvailableSchema.parse(await response.json());
    expect(retained.changeProposal.id).toBe(selected.id);
    expect(retained.reviewRevision.id).not.toBe(available.reviewRevision.id);
    expect(retained.reviewRevision).toMatchObject({
      base: { objectId: fixture.baseObjectId },
      head: { objectId: fixture.headObjectId },
    });
  });

  it("reuses a local-first Project when a later provider observation has a different exact change", async () => {
    if (
      stack === undefined ||
      fixture === undefined ||
      localFirstFixture === undefined ||
      nonmatchingFixture === undefined
    ) {
      throw new Error("Local-first provider fixture is unavailable");
    }
    const inventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const repository = inventory.repositories.find(
      ({ displayName }) => displayName === "local-first",
    );
    if (repository === undefined) throw new Error("Local-first repository is unavailable");
    const references = LocalRepositoryReferencesSchema.parse(
      await (
        await stack.fetchApi(
          `/api/v1/local-repository-sources/${repository.repositoryId}/references`,
        )
      ).json(),
    );
    expect(references.repositoryId).toBe(repository.repositoryId);
    const response = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify({
        repositoryId: repository.repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/review-source",
        changeIntent: "Review provider enrichment without duplicating the local review path",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(201);
    const local = ReviewRevisionAvailableSchema.parse(await response.json());
    expect(local.changeProposal.kind).toBe("local");

    const cloneFixture = await fixture.createClone(
      localFirstFixture.repositoryPath,
      "local-first-clone",
      "local-first",
    );
    expect(cloneFixture).toMatchObject({
      baseObjectId: localFirstFixture.baseObjectId,
      headObjectId: localFirstFixture.headObjectId,
    });
    const clonedInventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const clonedRepository = clonedInventory.repositories.find(
      ({ displayName }) => displayName === "local-first-clone",
    );
    if (clonedRepository === undefined) throw new Error("Local-first clone is unavailable");
    const clonedResponse = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify({
        repositoryId: clonedRepository.repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/review-source",
        changeProposalId: local.changeProposal.id,
        changeIntent: "Review the same exact local change from another clone",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(clonedResponse.status).toBe(201);
    const cloned = ReviewRevisionAvailableSchema.parse(await clonedResponse.json());
    expect(cloned.project.id).toBe(local.project.id);
    expect(cloned.changeProposal.id).toBe(local.changeProposal.id);
    expect(cloned.localRepositorySource.id).not.toBe(local.localRepositorySource.id);

    const enriched = await observePublicGitHubProject(stack, {
      baseObjectId: nonmatchingFixture.baseObjectId,
      headObjectId: nonmatchingFixture.headObjectId,
      name: "local-first",
      number: 190,
      suffix: "local_first",
      title: "Observe another exact change in the retained local repository",
    });
    expect(enriched.project.id).toBe(local.project.id);
    expect(enriched.project.changeProposals).toHaveLength(2);
    const retainedProposal = enriched.project.changeProposals.find(
      ({ id }) => id === local.changeProposal.id,
    );
    expect(retainedProposal).toMatchObject({ id: local.changeProposal.id, kind: "local" });
    expect((retainedProposal?.reviewRevisions ?? []).map(({ id }) => id)).toEqual(
      expect.arrayContaining([local.reviewRevision.id, cloned.reviewRevision.id]),
    );
    expect(enriched.project.changeProposals).toContainEqual(
      expect.objectContaining({
        kind: "provider_observed",
        providerId: "PR_issue90_local_first",
      }),
    );
    const staleProviderProposal = enriched.project.changeProposals.find(
      (proposal) => "providerId" in proposal && proposal.providerId === "PR_issue90_local_first",
    );
    if (staleProviderProposal === undefined) {
      throw new Error("Stale provider proposal is unavailable");
    }

    const reconciled = await observePublicGitHubProject(stack, {
      baseObjectId: localFirstFixture.baseObjectId,
      headObjectId: localFirstFixture.headObjectId,
      name: "local-first",
      number: 190,
      suffix: "local_first",
      title: "Observe the retained exact local change",
    });
    expect(reconciled.project.id).toBe(local.project.id);
    expect(reconciled.project.changeProposals).toHaveLength(1);
    expect(reconciled.project.changeProposals[0]).toMatchObject({
      id: local.changeProposal.id,
      kind: "provider_observed",
      providerId: "PR_issue90_local_first",
    });

    const aliasRetry = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify({
        repositoryId: repository.repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/review-source",
        changeProposalId: staleProviderProposal.id,
        changeIntent: "Retry through the durable provider proposal alias",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(aliasRetry.status).toBe(200);
    const aliasAvailable = ReviewRevisionAvailableSchema.parse(await aliasRetry.json());
    expect(aliasAvailable.changeProposal.id).toBe(local.changeProposal.id);
    expect(aliasAvailable.reviewRevision.id).toBe(local.reviewRevision.id);
  });

  it("canonically aliases a provider-first Project when a local source gains its GitHub identity", async () => {
    if (stack === undefined || fixture === undefined || lateRemoteFixture === undefined) {
      throw new Error("Late-remote provider fixture is unavailable");
    }
    const inventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const repository = inventory.repositories.find(
      ({ displayName }) => displayName === "late-remote",
    );
    if (repository === undefined) throw new Error("Late-remote repository is unavailable");
    const localResponse = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify({
        repositoryId: repository.repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/review-source",
        changeIntent: "Review the local change before provider metadata is available",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(localResponse.status).toBe(201);
    const local = ReviewRevisionAvailableSchema.parse(await localResponse.json());
    expect(local.project.providerObservation).toBeNull();

    const provider = await observePublicGitHubProject(stack, {
      baseObjectId: lateRemoteFixture.baseObjectId,
      headObjectId: lateRemoteFixture.headObjectId,
      name: "late-remote",
      number: 390,
      suffix: "late_remote",
      title: "Observe the provider before the local remote is configured",
    });
    expect(provider.project.id).not.toBe(local.project.id);
    const providerProposal = provider.project.changeProposals[0];
    if (providerProposal === undefined) throw new Error("Provider proposal is unavailable");

    const providerClone = await fixture.createClone(
      lateRemoteFixture.repositoryPath,
      "late-remote-provider-clone",
      "late-remote",
    );
    const providerCloneInventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const providerCloneRepository = providerCloneInventory.repositories.find(
      ({ displayName }) => displayName === "late-remote-provider-clone",
    );
    if (providerCloneRepository === undefined) {
      throw new Error("Provider Project clone is unavailable");
    }
    const providerRetainedResponse = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify({
        repositoryId: providerCloneRepository.repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/review-source",
        changeProposalId: providerProposal.id,
        changeIntent: "Retain provider-side history before the Project identities converge",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(providerRetainedResponse.status).toBe(201);
    const providerRetained = ReviewRevisionAvailableSchema.parse(
      await providerRetainedResponse.json(),
    );
    expect(providerRetained.project.id).toBe(provider.project.id);

    const secondProviderProposalObservation = await observePublicGitHubProject(stack, {
      baseObjectId: lateRemoteFixture.baseObjectId,
      headObjectId: lateRemoteFixture.headObjectId,
      name: "late-remote",
      number: 391,
      repositoryProviderId: "R_issue90_late_remote",
      suffix: "late_remote_second",
      title: "Observe a second provider proposal for the same exact change",
    });
    const secondProviderProposal = secondProviderProposalObservation.project.changeProposals.find(
      (proposal) =>
        "providerId" in proposal && proposal.providerId === "PR_issue90_late_remote_second",
    );
    if (secondProviderProposal === undefined) {
      throw new Error("Second provider proposal is unavailable");
    }
    const providerLocalProposalId = JSON.parse(
      await stack.executeWebModule(`
        import { createPool } from '@kestrel/database';
        const pool = createPool(process.env.DATABASE_URL, 'kestrel-provider-local-proposal-test');
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const actor = await client.query('SELECT id FROM operators ORDER BY created_at LIMIT 1');
          const result = await client.query(
            "INSERT INTO change_proposals (project_id, proposal_kind, title_snapshot, " +
            "base_ref_snapshot, base_object_id, head_ref_snapshot, head_object_id, observed_at) " +
            "VALUES ($1, 'local', 'Provider-side local proposal', 'refs/heads/other-base', $2, " +
            "'refs/heads/other-head', $3, NULL) RETURNING id",
            [${JSON.stringify(provider.project.id)}, ${JSON.stringify("c".repeat(40))}, ${JSON.stringify("d".repeat(40))}]
          );
          await client.query(${JSON.stringify(INSERT_UNRESOLVED_CHANGE_INTENT_SQL)}, [
            result.rows[0].id,
            1,
            'Review the provider-side local proposal',
            actor.rows[0].id,
            null
          ]);
          await client.query('COMMIT');
          process.stdout.write(JSON.stringify(result.rows[0].id));
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
          await pool.end();
        }
      `),
    ) as string;

    await fixture.setGitHubRemote(lateRemoteFixture.repositoryPath, "late-remote");
    const command = {
      repositoryId: repository.repositoryId,
      baseRef: "refs/heads/main",
      headRef: "refs/heads/review-source",
      changeProposalId: providerProposal.id,
      changeIntent: "Reuse the retained change after provider identity becomes available",
    };
    const reconciledResponse = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify(command),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (reconciledResponse.status !== 200) {
      const diagnostic = await stack.executeWebModule(`
        import { createPool, readProject } from '@kestrel/database';
        const pool = createPool(process.env.DATABASE_URL, 'kestrel-convergence-diagnostic');
        try {
          try {
            const project = await readProject(pool, ${JSON.stringify(local.project.id)}, ${JSON.stringify(local.reviewRevision.id)});
            process.stdout.write(JSON.stringify({ project }));
          } catch (error) {
            process.stdout.write(JSON.stringify({ name: error?.name, message: error?.message }));
          }
        } finally {
          await pool.end();
        }
      `);
      throw new Error(
        `Project convergence failed (${String(reconciledResponse.status)}): ${await reconciledResponse.text()}\n${diagnostic}\n${await stack.logs("web")}`,
      );
    }
    const reconciled = ReviewRevisionAvailableSchema.parse(await reconciledResponse.json());
    expect(reconciled.project.id).toBe(local.project.id);
    expect(reconciled.reviewRevision.id).toBe(local.reviewRevision.id);
    expect(reconciled.changeProposal).toMatchObject({
      id: local.changeProposal.id,
      kind: "provider_observed",
      providerId: "PR_issue90_late_remote",
    });
    expect(reconciled.project.changeProposals).toHaveLength(3);
    expect(reconciled.changeProposal.reviewRevisions.map(({ id }) => id)).toEqual(
      expect.arrayContaining([local.reviewRevision.id, providerRetained.reviewRevision.id]),
    );
    expect(reconciled.changeProposal.changeIntent).toMatchObject({
      text: command.changeIntent,
      version: 2,
    });
    expect(reconciled.project.changeProposals).toContainEqual(
      expect.objectContaining({
        kind: "provider_observed",
        providerId: "PR_issue90_late_remote_second",
      }),
    );
    const copiedProviderLocalProposal = reconciled.project.changeProposals.find(
      (proposal) => proposal.base.objectId === "c".repeat(40),
    );
    expect(copiedProviderLocalProposal).toMatchObject({ kind: "local" });

    const repeatedResponse = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify(command),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(repeatedResponse.status).toBe(200);
    const repeated = ReviewRevisionAvailableSchema.parse(await repeatedResponse.json());
    expect(repeated.project.id).toBe(local.project.id);
    expect(repeated.changeProposal.id).toBe(local.changeProposal.id);
    expect(repeated.reviewRevision.id).toBe(local.reviewRevision.id);

    const providerHistoryResponse = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify({
        repositoryId: providerCloneRepository.repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/review-source",
        changeProposalId: providerProposal.id,
        changeIntent: "Read retained history through the aliased provider Project",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(providerHistoryResponse.status).toBe(200);
    const providerHistory = ReviewRevisionAvailableSchema.parse(
      await providerHistoryResponse.json(),
    );
    expect(providerHistory.project.id).toBe(local.project.id);
    expect(providerHistory.changeProposal.id).toBe(local.changeProposal.id);
    expect(providerHistory.reviewRevision.id).toBe(providerRetained.reviewRevision.id);
    expect(providerHistory.changeProposal.changeIntent).toMatchObject({
      text: "Read retained history through the aliased provider Project",
      version: 3,
    });

    const aliasSourceAcquisitionResponse = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify({
        repositoryId: providerCloneRepository.repositoryId,
        baseRef: "refs/heads/review-source",
        headRef: "refs/heads/main",
        changeIntent: "Retain a new exact change from a source on the aliased Project",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(aliasSourceAcquisitionResponse.status).toBe(201);
    const aliasSourceAcquisition = ReviewRevisionAvailableSchema.parse(
      await aliasSourceAcquisitionResponse.json(),
    );
    expect(aliasSourceAcquisition.project.id).toBe(local.project.id);
    expect(aliasSourceAcquisition.localRepositorySource.id).toBe(
      providerRetained.localRepositorySource.id,
    );
    expect(aliasSourceAcquisition.changeProposal.kind).toBe("local");
    expect(aliasSourceAcquisition.reviewRevision).toMatchObject({
      base: { objectId: providerClone.headObjectId },
      head: { objectId: providerClone.baseObjectId },
    });

    await fixture.createClone(
      lateRemoteFixture.repositoryPath,
      "late-remote-post-merge-clone",
      "late-remote",
    );
    const postMergeInventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const postMergeRepository = postMergeInventory.repositories.find(
      ({ displayName }) => displayName === "late-remote-post-merge-clone",
    );
    if (postMergeRepository === undefined) {
      throw new Error("Post-merge clone is unavailable");
    }
    const postMergeAcquisitionResponse = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify({
        repositoryId: postMergeRepository.repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/review-source",
        changeProposalId: secondProviderProposal.id,
        changeIntent: "Retain through a second provider alias after Project convergence",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(postMergeAcquisitionResponse.status).toBe(201);
    const postMergeAcquisition = ReviewRevisionAvailableSchema.parse(
      await postMergeAcquisitionResponse.json(),
    );
    expect(postMergeAcquisition.project.id).toBe(local.project.id);
    expect(postMergeAcquisition.changeProposal).toMatchObject({
      kind: "provider_observed",
      providerId: "PR_issue90_late_remote_second",
    });

    const inbox = ProjectInboxSchema.parse(await (await stack.fetchApi("/api/v1/projects")).json());
    expect(inbox.projects.some(({ id }) => id === provider.project.id)).toBe(false);
    expect(
      inbox.projects.filter(({ repository: item }) => item?.name === "late-remote"),
    ).toHaveLength(1);
    const persistedIdentity = JSON.parse(
      await stack.executeWebModule(`
        import { createPool } from '@kestrel/database';
        const pool = createPool(process.env.DATABASE_URL, 'kestrel-late-identity-test');
        try {
          const result = await pool.query(\`
            SELECT source.github_owner_snapshot,
                   source.github_name_snapshot,
                   alias_project.canonical_project_id,
                   alias_proposal.canonical_change_proposal_id,
                   local_alias.canonical_change_proposal_id AS local_alias_target
            FROM local_repository_sources AS source
            INNER JOIN projects AS alias_project ON alias_project.id = $1
            INNER JOIN change_proposals AS alias_proposal ON alias_proposal.id = $2
            INNER JOIN change_proposals AS local_alias ON local_alias.id = $4
            WHERE source.id = $3
          \`, [
            ${JSON.stringify(provider.project.id)},
            ${JSON.stringify(providerProposal.id)},
            ${JSON.stringify(local.localRepositorySource.id)},
            ${JSON.stringify(providerLocalProposalId)}
          ]);
          process.stdout.write(JSON.stringify(result.rows[0]));
        } finally {
          await pool.end();
        }
      `),
    ) as Record<string, unknown>;
    expect(persistedIdentity).toEqual({
      canonical_change_proposal_id: local.changeProposal.id,
      canonical_project_id: local.project.id,
      github_name_snapshot: "late-remote",
      github_owner_snapshot: "Ic3b3rg",
      local_alias_target: copiedProviderLocalProposal?.id,
    });

    await expect(
      stack.executeRuntimeSql(
        `UPDATE local_repository_sources SET project_id = '${local.project.id}' WHERE id = '${providerRetained.localRepositorySource.id}'`,
      ),
    ).rejects.toThrow();

    await stack.restart("web");
    const attachedSources = JSON.parse(
      await stack.executeWebModule(`
        import { createPool } from '@kestrel/database';
        const pool = createPool(process.env.DATABASE_URL, 'kestrel-alias-attachment-test');
        try {
          const result = await pool.query(\`
            SELECT source.id
            FROM local_repository_sources AS source
            INNER JOIN projects AS source_project ON source_project.id = source.project_id
            WHERE COALESCE(source_project.canonical_project_id, source_project.id) = $1
              AND source.attachment_state = 'attached'
          \`, [${JSON.stringify(local.project.id)}]);
          process.stdout.write(JSON.stringify(result.rows));
        } finally {
          await pool.end();
        }
      `),
    ) as Array<{ id: string }>;
    expect(attachedSources).toHaveLength(1);
  });

  it("serializes concurrent local acquisition and provider observation into one review path", async () => {
    if (stack === undefined || concurrentFixture === undefined) {
      throw new Error("Concurrent provider fixture is unavailable");
    }
    const inventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const repository = inventory.repositories.find(
      ({ displayName }) => displayName === "concurrent",
    );
    if (repository === undefined) throw new Error("Concurrent repository is unavailable");

    const barrierResult = holdProviderIdentityLock(stack).then(
      () => null,
      (error: unknown) =>
        error instanceof Error ? error : new Error("Provider identity test barrier failed"),
    );
    await waitForProviderLockState(stack, ({ barrierHolders }) => barrierHolders === 1);
    const localResponsePromise = stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify({
        repositoryId: repository.repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/review-source",
        changeIntent: "Review the serialized local and provider identity",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const providerPromise = observePublicGitHubProject(stack, {
      baseObjectId: concurrentFixture.baseObjectId,
      headObjectId: concurrentFixture.headObjectId,
      name: "concurrent",
      number: 290,
      suffix: "concurrent",
      title: "Serialize provider and local identity",
    });
    await waitForProviderLockState(stack, ({ blockedWriters }) => blockedWriters === 2);

    const [localResponse, provider, barrierError] = await Promise.all([
      localResponsePromise,
      providerPromise,
      barrierResult,
    ]);
    if (barrierError !== null) throw barrierError;
    expect(localResponse.status).toBe(201);
    const local = ReviewRevisionAvailableSchema.parse(await localResponse.json());
    expect(provider.project.id).toBe(local.project.id);
    expect(provider.project.changeProposals).toHaveLength(1);
    expect(provider.project.changeProposals[0]).toMatchObject({
      id: local.changeProposal.id,
      kind: "provider_observed",
      providerId: "PR_issue90_concurrent",
    });
  }, 60_000);

  it("keeps retained bytes and attaches a fresh clone without rewriting source history", async () => {
    if (stack === undefined || fixture === undefined || available === undefined) {
      throw new Error("Available Review Revision fixture is unavailable");
    }
    await fixture.detach();
    await stack.restart("web");

    const inboxResponse = await stack.fetchApi("/api/v1/projects");
    expect(inboxResponse.status).toBe(200);
    const inbox = ProjectInboxSchema.parse(await inboxResponse.json());
    expect(inbox.projects).toHaveLength(4);
    const project = inbox.projects.find(({ id }) => id === available?.project.id);
    expect(project?.localRepositorySource?.state).toBe("detached");
    expect(project?.sourceAvailability).toBe("available");
    await expect(
      retainedFile(stack, available.reviewRevision.id, "head", "review.txt"),
    ).resolves.toEqual({ content: "committed head\n" });

    const freshClone = await fixture.createFreshClone("kestrel-fresh");
    expect(freshClone).toMatchObject({
      baseObjectId: fixture.baseObjectId,
      headObjectId: fixture.headObjectId,
    });
    const refreshedInventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const freshRepository = refreshedInventory.repositories.find(
      ({ displayName }) => displayName === "kestrel-fresh",
    );
    if (freshRepository === undefined) throw new Error("Fresh clone is unavailable");
    expect(freshRepository.attachmentState).toBe("unattached");
    const response = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify({
        repositoryId: freshRepository.repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/review-source",
        changeProposalId: available.changeProposal.id,
        changeIntent: "Review the same exact change from a fresh clone",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(201);
    const reattached = ReviewRevisionAvailableSchema.parse(await response.json());
    expect(reattached.project.id).toBe(available.project.id);
    expect(reattached.changeProposal.id).toBe(available.changeProposal.id);
    expect(reattached.localRepositorySource.id).not.toBe(available.localRepositorySource.id);
    expect(reattached.reviewRevision.id).not.toBe(available.reviewRevision.id);
    expect(reattached.localRepositorySource).toMatchObject({
      displayName: "kestrel-fresh",
      state: "attached",
    });
    await expect(
      retainedFile(stack, available.reviewRevision.id, "head", "review.txt"),
    ).resolves.toEqual({ content: "committed head\n" });
  });

  it("reuses a provider Project but creates a local proposal for a different exact change", async () => {
    if (stack === undefined || available === undefined || nonmatchingFixture === undefined) {
      throw new Error("Nonmatching provider Project fixture is unavailable");
    }
    const inventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const repository = inventory.repositories.find(
      ({ displayName }) => displayName === "provider-other-change",
    );
    if (repository === undefined) throw new Error("Provider Project repository is unavailable");
    const response = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify({
        repositoryId: repository.repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/review-source",
        changeIntent: "Review a different exact change in the same repository",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(201);
    const retained = ReviewRevisionAvailableSchema.parse(await response.json());
    expect(retained.reviewRevision).toMatchObject({
      base: { objectId: nonmatchingFixture.baseObjectId },
      head: { objectId: nonmatchingFixture.headObjectId },
    });
    expect(retained.project.id).toBe(available.project.id);
    expect(retained.changeProposal).toMatchObject({ kind: "local" });
    expect(retained.changeProposal.id).not.toBe(available.changeProposal.id);
    expect(retained.project.changeProposals).toHaveLength(3);
  });

  it("rejects nested and cross-family aliases inserted directly at transaction commit", async () => {
    if (stack === undefined) throw new Error("Local-source stack is unavailable");
    const constraints = JSON.parse(
      await stack.executeWebModule(`
        import { createPool } from '@kestrel/database';
        const pool = createPool(process.env.DATABASE_URL, 'kestrel-alias-insert-integrity-test');
        const client = await pool.connect();

        async function rejectedCommit(statement, parameters) {
          try {
            await client.query('BEGIN');
            await client.query(statement, parameters);
            try {
              await client.query('COMMIT');
              return { code: null, constraint: null };
            } catch (error) {
              await client.query('ROLLBACK').catch(() => undefined);
              return { code: error?.code ?? null, constraint: error?.constraint ?? null };
            }
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
          }
        }

        try {
          await client.query('SET search_path = pg_temp, public, pg_catalog');
          await client.query(
            'CREATE TEMP TABLE projects AS SELECT * FROM public.projects WITH NO DATA'
          );
          await client.query(
            'CREATE TEMP TABLE change_proposals AS SELECT * FROM public.change_proposals WITH NO DATA'
          );
          await client.query(
            'CREATE TEMP TABLE local_repository_sources AS ' +
            'SELECT * FROM public.local_repository_sources WITH NO DATA'
          );
          await client.query(
            'CREATE TEMP TABLE review_revisions AS SELECT * FROM public.review_revisions WITH NO DATA'
          );
          const installation = await client.query('SELECT id FROM public.installations LIMIT 1');
          const installationId = installation.rows[0].id;
          const firstProject = await client.query(
            'INSERT INTO public.projects (installation_id) VALUES ($1) RETURNING id',
            [installationId]
          );
          const secondProject = await client.query(
            'INSERT INTO public.projects (installation_id) VALUES ($1) RETURNING id',
            [installationId]
          );
          const directProjectAlias = await client.query(
            'INSERT INTO public.projects (installation_id, canonical_project_id) VALUES ($1, $2) RETURNING id',
            [installationId, firstProject.rows[0].id]
          );
          const canonicalProposal = await client.query(
            "INSERT INTO public.change_proposals (project_id, proposal_kind, title_snapshot, " +
            "base_ref_snapshot, base_object_id, head_ref_snapshot, head_object_id, observed_at) " +
            "VALUES ($1, 'local', 'Canonical local proposal', 'refs/heads/main', $2, " +
            "'refs/heads/review', $3, NULL) RETURNING id",
            [firstProject.rows[0].id, 'a'.repeat(40), 'b'.repeat(40)]
          );
          const directProposalAlias = await client.query(
            "INSERT INTO public.change_proposals (project_id, proposal_kind, canonical_change_proposal_id, " +
            "title_snapshot, base_ref_snapshot, base_object_id, head_ref_snapshot, head_object_id, observed_at) " +
            "VALUES ($1, 'alias', $2, 'Direct proposal alias', 'refs/heads/main', $3, " +
            "'refs/heads/review', $4, NULL) RETURNING id",
            [firstProject.rows[0].id, canonicalProposal.rows[0].id, 'a'.repeat(40), 'b'.repeat(40)]
          );

          const nestedProject = await rejectedCommit(
            'INSERT INTO public.projects (installation_id, canonical_project_id) VALUES ($1, $2)',
            [installationId, directProjectAlias.rows[0].id]
          );
          const nestedProposal = await rejectedCommit(
            "INSERT INTO public.change_proposals (project_id, proposal_kind, canonical_change_proposal_id, " +
            "title_snapshot, base_ref_snapshot, base_object_id, head_ref_snapshot, head_object_id, observed_at) " +
            "VALUES ($1, 'alias', $2, 'Nested proposal alias', 'refs/heads/main', $3, " +
            "'refs/heads/review', $4, NULL)",
            [firstProject.rows[0].id, directProposalAlias.rows[0].id, 'a'.repeat(40), 'b'.repeat(40)]
          );
          const crossFamilyProposal = await rejectedCommit(
            "INSERT INTO public.change_proposals (project_id, proposal_kind, canonical_change_proposal_id, " +
            "title_snapshot, base_ref_snapshot, base_object_id, head_ref_snapshot, head_object_id, observed_at) " +
            "VALUES ($1, 'alias', $2, 'Cross-family proposal alias', 'refs/heads/main', $3, " +
            "'refs/heads/review', $4, NULL)",
            [secondProject.rows[0].id, canonicalProposal.rows[0].id, 'a'.repeat(40), 'b'.repeat(40)]
          );
          process.stdout.write(JSON.stringify({ crossFamilyProposal, nestedProject, nestedProposal }));
        } finally {
          client.release();
          await pool.end();
        }
      `),
    ) as Record<string, { code: string | null; constraint: string | null }>;

    expect(constraints).toEqual({
      crossFamilyProposal: {
        code: "23514",
        constraint: "change_proposals_canonical_family",
      },
      nestedProject: { code: "23514", constraint: "projects_direct_canonical_alias" },
      nestedProposal: {
        code: "23514",
        constraint: "change_proposals_canonical_family",
      },
    });
  });

  it("selects the highest Change Intent version even when its clock is older", async () => {
    if (stack === undefined) throw new Error("Local-source stack is unavailable");
    const currentIntent = JSON.parse(
      await stack.executeWebModule(`
        import { createPool, readProject } from '@kestrel/database';
        const pool = createPool(process.env.DATABASE_URL, 'kestrel-intent-version-order-test');
        try {
          const installation = await pool.query('SELECT id FROM installations LIMIT 1');
          const operator = await pool.query('SELECT id FROM operators ORDER BY created_at LIMIT 1');
          const project = await pool.query(
            'INSERT INTO projects (installation_id) VALUES ($1) RETURNING id',
            [installation.rows[0].id]
          );
          const proposal = await pool.query(
            "INSERT INTO change_proposals (project_id, proposal_kind, title_snapshot, " +
            "base_ref_snapshot, base_object_id, head_ref_snapshot, head_object_id, observed_at) " +
            "VALUES ($1, 'local', 'Version ordering', 'refs/heads/main', $2, " +
            "'refs/heads/review', $3, NULL) RETURNING id",
            [project.rows[0].id, '1'.repeat(40), '2'.repeat(40)]
          );
          await pool.query(${JSON.stringify(INSERT_UNRESOLVED_CHANGE_INTENT_SQL)}, [
            proposal.rows[0].id,
            1,
            'Version one',
            operator.rows[0].id,
            '2026-08-26T12:00:02Z'
          ]);
          await pool.query(${JSON.stringify(INSERT_UNRESOLVED_CHANGE_INTENT_SQL)}, [
            proposal.rows[0].id,
            2,
            'Version two',
            operator.rows[0].id,
            '2026-08-26T12:00:01Z'
          ]);
          const result = await readProject(pool, project.rows[0].id);
          process.stdout.write(JSON.stringify(result.changeProposals[0].changeIntent));
        } finally {
          await pool.end();
        }
      `),
    ) as { text: string; version: number };

    expect(currentIntent).toMatchObject({ text: "Version two", version: 2 });
  });

  it("serializes attached sources across one canonical Project family", async () => {
    if (stack === undefined) throw new Error("Local-source stack is unavailable");
    const result = JSON.parse(
      await stack.executeWebModule(`
        import { randomBytes, randomUUID } from 'node:crypto';
        import { createPool } from '@kestrel/database';
        const pool = createPool(process.env.DATABASE_URL, 'kestrel-source-family-lock-test');
        const first = await pool.connect();
        const second = await pool.connect();
        let firstOpen = false;
        let secondOpen = false;
        try {
          const installation = await pool.query('SELECT id FROM installations LIMIT 1');
          const canonical = await pool.query(
            'INSERT INTO projects (installation_id) VALUES ($1) RETURNING id',
            [installation.rows[0].id]
          );
          const alias = await pool.query(
            'INSERT INTO projects (installation_id, canonical_project_id) VALUES ($1, $2) RETURNING id',
            [installation.rows[0].id, canonical.rows[0].id]
          );
          const insertSource =
            "INSERT INTO local_repository_sources (installation_id, project_id, source_identity, " +
            "repository_id, root_id, repository_relative_locator, display_name_snapshot, " +
            "object_format, attachment_state) VALUES ($1, $2, $3, $4, $5, '', $6, 'sha1', 'attached')";

          await first.query('BEGIN');
          firstOpen = true;
          await first.query(insertSource, [
            installation.rows[0].id,
            canonical.rows[0].id,
            randomBytes(32).toString('hex'),
            randomUUID(),
            randomUUID(),
            'canonical source'
          ]);

          await second.query('BEGIN');
          secondOpen = true;
          const backend = await second.query('SELECT pg_backend_pid() AS pid');
          const secondInsert = second.query(insertSource, [
            installation.rows[0].id,
            alias.rows[0].id,
            randomBytes(32).toString('hex'),
            randomUUID(),
            randomUUID(),
            'alias source'
          ]);
          let blocked = false;
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            const activity = await pool.query(
              'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
              [backend.rows[0].pid]
            );
            if (activity.rows[0]?.wait_event_type === 'Lock') {
              blocked = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          await first.query('COMMIT');
          firstOpen = false;
          await secondInsert;
          let failure = { code: null, constraint: null };
          try {
            await second.query('COMMIT');
            secondOpen = false;
          } catch (error) {
            failure = { code: error?.code ?? null, constraint: error?.constraint ?? null };
            await second.query('ROLLBACK').catch(() => undefined);
            secondOpen = false;
          }
          process.stdout.write(JSON.stringify({ blocked, ...failure }));
        } finally {
          if (firstOpen) await first.query('ROLLBACK').catch(() => undefined);
          if (secondOpen) await second.query('ROLLBACK').catch(() => undefined);
          first.release();
          second.release();
          await pool.end();
        }
      `),
    ) as { blocked: boolean; code: string | null; constraint: string | null };

    expect(result).toEqual({
      blocked: true,
      code: "23514",
      constraint: "local_sources_current_project_family",
    });
  });

  it("revalidates a revision after a concurrent Project alias move", async () => {
    if (stack === undefined) throw new Error("Local-source stack is unavailable");

    await expect(exerciseConcurrentRevisionFamilyMove(stack, "project_alias")).resolves.toEqual({
      blocked: true,
      code: "23514",
      constraint: "review_revisions_source_project_family",
    });
  });

  it("revalidates a revision after its source moves concurrently", async () => {
    if (stack === undefined) throw new Error("Local-source stack is unavailable");

    await expect(exerciseConcurrentRevisionFamilyMove(stack, "source")).resolves.toEqual({
      blocked: true,
      code: "23514",
      constraint: "review_revisions_source_project_family",
    });
  });

  it("serializes a Project alias move against a concurrent source attachment", async () => {
    if (stack === undefined) throw new Error("Local-source stack is unavailable");
    const result = JSON.parse(
      await stack.executeWebModule(`
        import { randomBytes, randomUUID } from 'node:crypto';
        import { createPool } from '@kestrel/database';
        const pool = createPool(process.env.DATABASE_URL, 'kestrel-project-family-move-lock-test');
        const mover = await pool.connect();
        const writer = await pool.connect();
        let moverOpen = false;
        let writerOpen = false;
        try {
          const installation = await pool.query('SELECT id FROM installations LIMIT 1');
          const firstFamily = await pool.query(
            'INSERT INTO projects (installation_id) VALUES ($1) RETURNING id',
            [installation.rows[0].id]
          );
          const secondFamily = await pool.query(
            'INSERT INTO projects (installation_id) VALUES ($1) RETURNING id',
            [installation.rows[0].id]
          );
          const alias = await pool.query(
            'INSERT INTO projects (installation_id, canonical_project_id) VALUES ($1, $2) RETURNING id',
            [installation.rows[0].id, firstFamily.rows[0].id]
          );
          const insertSource =
            "INSERT INTO local_repository_sources (installation_id, project_id, source_identity, " +
            "repository_id, root_id, repository_relative_locator, display_name_snapshot, " +
            "object_format, attachment_state) VALUES ($1, $2, $3, $4, $5, '', $6, 'sha1', 'attached')";
          await pool.query(insertSource, [
            installation.rows[0].id,
            alias.rows[0].id,
            randomBytes(32).toString('hex'),
            randomUUID(),
            randomUUID(),
            'moving source'
          ]);

          await mover.query('BEGIN');
          moverOpen = true;
          await mover.query(
            'UPDATE projects SET canonical_project_id = $2 WHERE id = $1',
            [alias.rows[0].id, secondFamily.rows[0].id]
          );

          await writer.query('BEGIN');
          writerOpen = true;
          const backend = await writer.query('SELECT pg_backend_pid() AS pid');
          const insertion = writer.query(insertSource, [
            installation.rows[0].id,
            secondFamily.rows[0].id,
            randomBytes(32).toString('hex'),
            randomUUID(),
            randomUUID(),
            'concurrent source'
          ]);
          let blocked = false;
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            const activity = await pool.query(
              'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
              [backend.rows[0].pid]
            );
            if (activity.rows[0]?.wait_event_type === 'Lock') {
              blocked = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          await mover.query('COMMIT');
          moverOpen = false;
          await insertion;
          let failure = { code: null, constraint: null };
          try {
            await writer.query('COMMIT');
            writerOpen = false;
          } catch (error) {
            failure = { code: error?.code ?? null, constraint: error?.constraint ?? null };
            await writer.query('ROLLBACK').catch(() => undefined);
            writerOpen = false;
          }
          process.stdout.write(JSON.stringify({ blocked, ...failure }));
        } finally {
          if (moverOpen) await mover.query('ROLLBACK').catch(() => undefined);
          if (writerOpen) await writer.query('ROLLBACK').catch(() => undefined);
          mover.release();
          writer.release();
          await pool.end();
        }
      `),
    ) as { blocked: boolean; code: string | null; constraint: string | null };

    expect(result).toEqual({
      blocked: true,
      code: "23514",
      constraint: "local_sources_current_project_family",
    });
  });

  it("rejects concurrent Project and Change Proposal alias cycles", async () => {
    if (stack === undefined) throw new Error("Local-source stack is unavailable");
    const result = JSON.parse(
      await stack.executeWebModule(`
        import { createPool } from '@kestrel/database';
        const pool = createPool(process.env.DATABASE_URL, 'kestrel-alias-cycle-lock-test');

        async function concurrentAliasCycle(table, firstId, secondId, update) {
          const first = await pool.connect();
          const second = await pool.connect();
          let firstOpen = false;
          let secondOpen = false;
          try {
            await first.query('BEGIN');
            firstOpen = true;
            await first.query(update, [firstId, secondId]);
            await second.query('BEGIN');
            secondOpen = true;
            const backend = await second.query('SELECT pg_backend_pid() AS pid');
            const conflicting = second.query(update, [secondId, firstId]);
            let blocked = false;
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) {
              const activity = await pool.query(
                'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
                [backend.rows[0].pid]
              );
              if (activity.rows[0]?.wait_event_type === 'Lock') {
                blocked = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            await first.query('COMMIT');
            firstOpen = false;
            await conflicting;
            let failure = { code: null, constraint: null };
            try {
              await second.query('COMMIT');
              secondOpen = false;
            } catch (error) {
              failure = { code: error?.code ?? null, constraint: error?.constraint ?? null };
              await second.query('ROLLBACK').catch(() => undefined);
              secondOpen = false;
            }
            return { blocked, table, ...failure };
          } finally {
            if (firstOpen) await first.query('ROLLBACK').catch(() => undefined);
            if (secondOpen) await second.query('ROLLBACK').catch(() => undefined);
            first.release();
            second.release();
          }
        }

        try {
          const installation = await pool.query('SELECT id FROM installations LIMIT 1');
          const projectA = await pool.query(
            'INSERT INTO projects (installation_id) VALUES ($1) RETURNING id',
            [installation.rows[0].id]
          );
          const projectB = await pool.query(
            'INSERT INTO projects (installation_id) VALUES ($1) RETURNING id',
            [installation.rows[0].id]
          );
          const projects = await concurrentAliasCycle(
            'projects',
            projectA.rows[0].id,
            projectB.rows[0].id,
            'UPDATE projects SET canonical_project_id = $2 WHERE id = $1'
          );

          const proposalProject = await pool.query(
            'INSERT INTO projects (installation_id) VALUES ($1) RETURNING id',
            [installation.rows[0].id]
          );
          const createProposal =
            "INSERT INTO change_proposals (project_id, proposal_kind, title_snapshot, " +
            "base_ref_snapshot, base_object_id, head_ref_snapshot, head_object_id, observed_at) " +
            "VALUES ($1, 'local', $2, 'refs/heads/main', $3, 'refs/heads/review', $4, NULL) RETURNING id";
          const proposalA = await pool.query(createProposal, [
            proposalProject.rows[0].id,
            'Proposal A',
            '7'.repeat(40),
            '8'.repeat(40)
          ]);
          const proposalB = await pool.query(createProposal, [
            proposalProject.rows[0].id,
            'Proposal B',
            '9'.repeat(40),
            'a'.repeat(40)
          ]);
          const proposals = await concurrentAliasCycle(
            'change_proposals',
            proposalA.rows[0].id,
            proposalB.rows[0].id,
            "UPDATE change_proposals SET proposal_kind = 'alias', " +
            'canonical_change_proposal_id = $2 WHERE id = $1'
          );
          process.stdout.write(JSON.stringify({ projects, proposals }));
        } finally {
          await pool.end();
        }
      `),
    ) as Record<
      "projects" | "proposals",
      { blocked: boolean; code: string | null; constraint: string | null; table: string }
    >;

    expect(result).toEqual({
      projects: {
        blocked: true,
        code: "23514",
        constraint: "projects_direct_canonical_alias",
        table: "projects",
      },
      proposals: {
        blocked: true,
        code: "23514",
        constraint: "change_proposals_canonical_family",
        table: "change_proposals",
      },
    });
  });

  it("reclaims only stale acquiring revisions without a live session lease", async () => {
    if (stack === undefined) throw new Error("Local-source stack is unavailable");
    const result = JSON.parse(
      await stack.executeWebModule(`
        import { randomBytes, randomUUID } from 'node:crypto';
        import { createPool, reconcileAcquiringRevisions } from '@kestrel/database';
        const pool = createPool(process.env.DATABASE_URL, 'kestrel-revision-lease-test');
        const lease = await pool.connect();
        let leasedRevisionId = null;
        try {
          const installation = await pool.query('SELECT id FROM installations LIMIT 1');
          const operator = await pool.query('SELECT id FROM operators ORDER BY created_at LIMIT 1');
          const project = await pool.query(
            'INSERT INTO projects (installation_id) VALUES ($1) RETURNING id',
            [installation.rows[0].id]
          );
          const source = await pool.query(
            "INSERT INTO local_repository_sources (installation_id, project_id, source_identity, " +
            "repository_id, root_id, repository_relative_locator, display_name_snapshot, " +
            "object_format, attachment_state) VALUES ($1, $2, $3, $4, $5, '', " +
            "'lease source', 'sha1', 'attached') RETURNING id",
            [
              installation.rows[0].id,
              project.rows[0].id,
              randomBytes(32).toString('hex'),
              randomUUID(),
              randomUUID()
            ]
          );

          const revisions = [];
          for (const [label, base, head] of [
            ['live', '3'.repeat(40), '4'.repeat(40)],
            ['orphan', '5'.repeat(40), '6'.repeat(40)]
          ]) {
            const proposal = await pool.query(
              "INSERT INTO change_proposals (project_id, proposal_kind, title_snapshot, " +
              "base_ref_snapshot, base_object_id, head_ref_snapshot, head_object_id, observed_at) " +
              "VALUES ($1, 'local', $2, 'refs/heads/main', $3, 'refs/heads/review', $4, NULL) RETURNING id",
              [project.rows[0].id, label, base, head]
            );
            const intent = await pool.query(${JSON.stringify(INSERT_UNRESOLVED_CHANGE_INTENT_SQL)}, [
              proposal.rows[0].id,
              1,
              label + ' intent',
              operator.rows[0].id,
              null
            ]);
            const revision = await pool.query(
              "INSERT INTO review_revisions (project_id, change_proposal_id, " +
              "local_repository_source_id, acquisition_change_intent_id, revision_state, " +
              "base_ref_snapshot, base_object_id, head_ref_snapshot, head_object_id, object_format, " +
              "max_bytes, max_objects, created_at, updated_at) VALUES ($1, $2, $3, $4, " +
              "'acquiring', 'refs/heads/main', $5, 'refs/heads/review', $6, 'sha1', 1048576, 1000, " +
              "clock_timestamp() - interval '31 minutes', " +
              "clock_timestamp() - interval '31 minutes') RETURNING id",
              [project.rows[0].id, proposal.rows[0].id, source.rows[0].id, intent.rows[0].id, base, head]
            );
            revisions.push({ id: revision.rows[0].id, label });
          }
          leasedRevisionId = revisions[0].id;
          await lease.query(
            "SELECT pg_advisory_lock(hashtextextended('kestrel-review-revision:' || $1, 0))",
            [leasedRevisionId]
          );
          const reclaimed = await reconcileAcquiringRevisions(pool);
          const states = await pool.query(
            'SELECT id, revision_state, failure_reason FROM review_revisions WHERE id = ANY($1::uuid[]) ORDER BY id',
            [revisions.map(({ id }) => id)]
          );
          process.stdout.write(JSON.stringify({ reclaimed, revisions, states: states.rows }));
        } finally {
          if (leasedRevisionId !== null) {
            await lease.query(
              "SELECT pg_advisory_unlock(hashtextextended('kestrel-review-revision:' || $1, 0))",
              [leasedRevisionId]
            ).catch(() => undefined);
          }
          lease.release();
          await pool.end();
        }
      `),
    ) as {
      reclaimed: number;
      revisions: Array<{ id: string; label: string }>;
      states: Array<{ failure_reason: string | null; id: string; revision_state: string }>;
    };
    const stateByLabel = Object.fromEntries(
      result.revisions.map(({ id, label }) => [
        label,
        result.states.find((state) => state.id === id),
      ]),
    );

    expect(result.reclaimed).toBe(1);
    expect(stateByLabel).toMatchObject({
      live: { failure_reason: null, revision_state: "acquiring" },
      orphan: {
        failure_reason: "acquisition_interrupted",
        revision_state: "unavailable",
      },
    });
  });

  it(
    "freezes revision and intent rows retained through a canonical proposal alias",
    exerciseAliasedReviewWorkflow,
  );
});

describe("observed GitHub pull request acquisition", () => {
  const repositoryName = "observed-pr";
  const pullRequestNumber = 50;
  const movedRepositoryName = "observed-pr-moved";
  const movedPullRequestNumber = 51;
  let fixture: GitFixture | undefined;
  let pullRequest: MissingPullRequestFixture | undefined;
  let movedPullRequest: MissingPullRequestFixture | undefined;
  let stack: RunningStack | undefined;

  beforeAll(async () => {
    fixture = await createGitFixture();
    const [primary, moved] = await Promise.all([
      fixture.createMissingPullRequestClone(repositoryName, pullRequestNumber),
      fixture.createMissingPullRequestClone(movedRepositoryName, movedPullRequestNumber),
    ]);
    pullRequest = primary;
    movedPullRequest = moved;
    const movedProviderPath = join(fixture.rootPath, moved.providerRelativePath);
    await runFixtureGit(movedProviderPath, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await runFixtureGit(movedProviderPath, [
      "update-ref",
      `refs/pull/${String(movedPullRequestNumber)}/head`,
      moved.baseObjectId,
      moved.headObjectId,
    ]);
    await runFixtureGit(movedProviderPath, [
      "update-ref",
      "-d",
      "refs/heads/review-source",
      moved.headObjectId,
    ]);
    await runFixtureGit(movedProviderPath, [
      "update-ref",
      "-d",
      "refs/tags/head-alias",
      moved.headObjectId,
    ]);
    await runFixtureGit(movedProviderPath, ["reflog", "expire", "--expire=now", "--all"]);
    await runFixtureGit(movedProviderPath, ["gc", "--prune=now"]);
    await expect(
      runFixtureGit(movedProviderPath, ["cat-file", "-e", `${moved.headObjectId}^{commit}`]),
    ).rejects.toThrow();
    stack = await startStack({
      gitHubRemoteMappings: {
        [`https://github.com/Ic3b3rg/${repositoryName}.git`]: `/fixtures/repositories/${primary.providerRelativePath}`,
        [`https://github.com/Ic3b3rg/${movedRepositoryName}.git`]: `/fixtures/repositories/${moved.providerRelativePath}`,
      },
      repositoryRoot: fixture.rootPath,
    });
    await stack.authenticateOperator();
  });

  afterAll(async () => {
    if (stack !== undefined) await stack.close();
    if (fixture !== undefined) await fixture.close();
  });

  it("fetches only missing observed PR objects into an isolated repository", async () => {
    if (stack === undefined || fixture === undefined || pullRequest === undefined) {
      throw new Error("Observed pull-request fixture is unavailable");
    }
    const activeStack = stack;
    const inventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const repository = inventory.repositories.find(
      ({ displayName }) => displayName === repositoryName,
    );
    if (repository === undefined) throw new Error("Observed pull-request clone is unavailable");
    const beforeFingerprint = await fixture.snapshotRepository(pullRequest.repositoryPath);

    const localResponse = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify({
        repositoryId: repository.repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/attachment-source",
        changeIntent: "Attach the authorized clone before observing the provider proposal",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(localResponse.status).toBe(201);
    const local = ReviewRevisionAvailableSchema.parse(await localResponse.json());
    expect(local.reviewRevision).toMatchObject({
      base: { objectId: pullRequest.baseObjectId },
      head: { objectId: pullRequest.localHeadObjectId },
    });

    const observed = await observePublicGitHubProject(stack, {
      baseObjectId: pullRequest.baseObjectId,
      headObjectId: pullRequest.headObjectId,
      name: repositoryName,
      number: pullRequestNumber,
      suffix: "remote_acquisition",
      title: "Acquire a missing observed pull request revision",
    });
    expect(observed.project.id).toBe(local.project.id);
    const proposal = observed.project.changeProposals.find(
      (candidate) =>
        "providerId" in candidate && candidate.providerId === "PR_issue90_remote_acquisition",
    );
    if (proposal === undefined) throw new Error("Observed pull-request proposal is unavailable");

    const command = {
      projectId: observed.project.id,
      changeProposalId: proposal.id,
      changeIntent: "Review the exact provider-observed pull request revision",
    };
    expect(Object.keys(command).sort()).toEqual(["changeIntent", "changeProposalId", "projectId"]);
    const [firstResponse, repeatedResponse] = await Promise.all([
      activeStack.fetchApi("/api/v1/review-revisions", {
        body: JSON.stringify(command),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
      activeStack.fetchApi("/api/v1/review-revisions", {
        body: JSON.stringify(command),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    ]);
    const [firstBody, repeatedBody]: [unknown, unknown] = await Promise.all([
      firstResponse.json() as Promise<unknown>,
      repeatedResponse.json() as Promise<unknown>,
    ]);
    expect(
      [firstResponse.status, repeatedResponse.status].sort(),
      JSON.stringify({ firstBody, repeatedBody }),
    ).toEqual([201, 409]);
    const concurrentResults: Array<{ body: unknown; status: number }> = [
      { body: firstBody, status: firstResponse.status },
      { body: repeatedBody, status: repeatedResponse.status },
    ];
    const createdResult = concurrentResults.find(({ status }) => status === 201);
    const acquiringResult = concurrentResults.find(({ status }) => status === 409);
    if (createdResult === undefined || acquiringResult === undefined) {
      throw new Error("Observed pull-request concurrency result is unavailable");
    }
    const first = ReviewRevisionAvailableSchema.parse(createdResult.body);
    expect(ApiErrorSchema.parse(acquiringResult.body)).toMatchObject({
      code: "REVISION_ACQUIRING",
    });
    const retryResponse = await activeStack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify(command),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(retryResponse.status).toBe(200);
    const repeated = ReviewRevisionAvailableSchema.parse(await retryResponse.json());
    expect(repeated.reviewRevision.id).toBe(first.reviewRevision.id);
    expect(first.reviewRevision).toMatchObject({
      state: "available",
      base: { objectId: pullRequest.baseObjectId },
      head: { objectId: pullRequest.headObjectId },
    });
    expect(first.changeProposal.id).toBe(proposal.id);
    const renderingCount = Number(
      await stack.executeWebModule(`
        import { createPool } from '@kestrel/database';
        const pool = createPool(process.env.DATABASE_URL, 'kestrel-observed-retention-rendering-test');
        try {
          const result = await pool.query(
            'SELECT count(*)::text AS count FROM change_overview_renderings WHERE review_revision_id = $1',
            [${JSON.stringify(first.reviewRevision.id)}]
          );
          process.stdout.write(result.rows[0].count);
        } finally {
          await pool.end();
        }
      `),
    );
    expect(renderingCount).toBe(0);
    expect(await fixture.snapshotRepository(pullRequest.repositoryPath)).toBe(beforeFingerprint);
    await expect(
      retainedFile(stack, first.reviewRevision.id, "base", "review.txt"),
    ).resolves.toEqual({ content: "committed base observed-pr-provider\n" });
    await expect(
      retainedFile(stack, first.reviewRevision.id, "head", "review.txt"),
    ).resolves.toEqual({ content: "committed head observed-pr-provider\n" });

    const providerPath = join(fixture.rootPath, pullRequest.providerRelativePath);
    const unavailableProviderPath = `${providerPath}-unavailable`;
    await rename(providerPath, unavailableProviderPath);
    try {
      const retainedRetry = await activeStack.fetchApi("/api/v1/review-revisions", {
        body: JSON.stringify(command),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      expect(retainedRetry.status).toBe(200);
      expect(
        ReviewRevisionAvailableSchema.parse(await retainedRetry.json()).reviewRevision,
      ).toMatchObject({ id: first.reviewRevision.id, state: "available" });
    } finally {
      await rename(unavailableProviderPath, providerPath);
    }

    const boundary = JSON.parse(
      await stack.executeWebModule(`
        import { lstat, readFile, readdir } from 'node:fs/promises';
        import { join } from 'node:path';
        import { readLocalSourceConfig } from '@kestrel/local-source';
        const commands = (await readFile('/tmp/kestrel-git-commands.log', 'utf8'))
          .split(/\\r?\\n/u)
          .filter(Boolean);
        const environment = await readFile('/tmp/kestrel-git-environment.log', 'utf8');
        const canaryInvoked = await lstat(${JSON.stringify(LOCAL_SOURCE_COMMAND_CANARY_PATH)})
          .then(() => true)
          .catch((error) => {
            if (error?.code === 'ENOENT') return false;
            throw error;
          });
        const config = await readLocalSourceConfig();
        const acquisitionRoot = join(
          config.artifactRoot,
          'projects',
          ${JSON.stringify(observed.project.id)},
          'acquisition-repositories',
        );
        const acquisitionEntries = await readdir(acquisitionRoot)
          .catch((error) => {
            if (error?.code === 'ENOENT') return [];
            throw error;
          });
        process.stdout.write(JSON.stringify({
          acquisitionEntries,
          canaryInvoked,
          commands,
          environment,
        }));
      `),
    ) as {
      acquisitionEntries: string[];
      canaryInvoked: boolean;
      commands: string[];
      environment: string;
    };
    const fetchCommands = boundary.commands.filter((candidate) => candidate.includes(" fetch "));
    expect(fetchCommands).toHaveLength(1);
    expect(fetchCommands[0]).toContain("core.hooksPath=/dev/null");
    expect(fetchCommands[0]).toContain("credential.interactive=never");
    expect(fetchCommands[0]).toContain("protocol.file.allow=never");
    expect(fetchCommands[0]).toContain("--atomic --depth=1");
    expect(fetchCommands[0]).toContain("--no-recurse-submodules --no-tags");
    expect(fetchCommands[0]).toContain("--refmap= --");
    expect(fetchCommands[0]).toContain(
      `https://github.com/Ic3b3rg/${repositoryName}.git +refs/heads/main:refs/kestrel/base +refs/pull/${String(pullRequestNumber)}/head:refs/kestrel/head`,
    );
    expect(fetchCommands[0]).not.toContain(pullRequest.providerRelativePath);
    expect(boundary.environment).not.toContain("provider-client-canary");
    expect(boundary.environment).not.toContain(pullRequest.repositoryPath);
    expect(boundary.acquisitionEntries).toEqual([]);
    expect(boundary.canaryInvoked).toBe(false);
  }, 60_000);

  it("fails closed when a moved pull ref no longer exposes the captured head", async () => {
    if (stack === undefined || fixture === undefined || movedPullRequest === undefined) {
      throw new Error("Moved pull-request fixture is unavailable");
    }
    const inventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const repository = inventory.repositories.find(
      ({ displayName }) => displayName === movedRepositoryName,
    );
    if (repository === undefined) throw new Error("Moved pull-request clone is unavailable");
    const beforeFingerprint = await fixture.snapshotRepository(movedPullRequest.repositoryPath);

    const localResponse = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify({
        repositoryId: repository.repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/attachment-source",
        changeIntent: "Attach the authorized clone before testing pull-ref movement",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(localResponse.status).toBe(201);
    const local = ReviewRevisionAvailableSchema.parse(await localResponse.json());

    const observed = await observePublicGitHubProject(stack, {
      baseObjectId: movedPullRequest.baseObjectId,
      headObjectId: movedPullRequest.headObjectId,
      name: movedRepositoryName,
      number: movedPullRequestNumber,
      suffix: "remote_moved",
      title: "Reject a moved pull request revision",
    });
    expect(observed.project.id).toBe(local.project.id);
    const proposal = observed.project.changeProposals.find(
      (candidate) =>
        "providerId" in candidate && candidate.providerId === "PR_issue90_remote_moved",
    );
    if (proposal === undefined) throw new Error("Moved pull-request proposal is unavailable");

    const response = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify({
        projectId: observed.project.id,
        changeProposalId: proposal.id,
        changeIntent: "Retain only the exact captured head after pull-ref movement",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = await response.text();
    expect(response.status, body).toBe(409);
    expect(ApiErrorSchema.parse(JSON.parse(body))).toMatchObject({ code: "PULL_REF_MISMATCH" });
    expect(body).not.toContain(join(fixture.rootPath, movedPullRequest.providerRelativePath));

    const persisted = JSON.parse(
      await stack.executeWebModule(`
        import { createPool } from '@kestrel/database';
        const pool = createPool(process.env.DATABASE_URL, 'kestrel-pull-ref-mismatch-test');
        try {
          const result = await pool.query(
            "SELECT revision_state, failure_reason, artifact_locator, manifest_digest FROM review_revisions WHERE head_object_id = $1",
            [${JSON.stringify(movedPullRequest.headObjectId)}]
          );
          process.stdout.write(JSON.stringify(result.rows));
        } finally {
          await pool.end();
        }
      `),
    ) as Array<{
      artifact_locator: string | null;
      failure_reason: string;
      manifest_digest: string | null;
      revision_state: string;
    }>;
    expect(persisted).toEqual([
      {
        artifact_locator: null,
        failure_reason: "pull_ref_mismatch",
        manifest_digest: null,
        revision_state: "unavailable",
      },
    ]);

    const boundary = JSON.parse(
      await stack.executeWebModule(`
        import { readFile, readdir } from 'node:fs/promises';
        import { join } from 'node:path';
        import { readLocalSourceConfig } from '@kestrel/local-source';
        const commands = (await readFile('/tmp/kestrel-git-commands.log', 'utf8'))
          .split(/\\r?\\n/u)
          .filter((candidate) => candidate.includes(${JSON.stringify(
            `https://github.com/Ic3b3rg/${movedRepositoryName}.git`,
          )}));
        const config = await readLocalSourceConfig();
        const acquisitionRoot = join(
          config.artifactRoot,
          'projects',
          ${JSON.stringify(observed.project.id)},
          'acquisition-repositories',
        );
        const acquisitionEntries = await readdir(acquisitionRoot).catch((error) => {
          if (error?.code === 'ENOENT') return [];
          throw error;
        });
        process.stdout.write(JSON.stringify({ acquisitionEntries, commands }));
      `),
    ) as { acquisitionEntries: string[]; commands: string[] };
    expect(boundary.commands).toHaveLength(2);
    expect(boundary.commands[0]).toContain(
      `+refs/pull/${String(movedPullRequestNumber)}/head:refs/kestrel/head`,
    );
    expect(boundary.commands[1]).toContain(`+${movedPullRequest.headObjectId}:refs/kestrel/head`);
    expect(boundary.commands.join(" ")).not.toContain(movedPullRequest.providerRelativePath);
    expect(boundary.acquisitionEntries).toEqual([]);
    expect(await fixture.snapshotRepository(movedPullRequest.repositoryPath)).toBe(
      beforeFingerprint,
    );
  }, 60_000);
});

describe("bounded local Review Revision failure", () => {
  let fixture: GitFixture | undefined;
  let stack: RunningStack | undefined;

  beforeAll(async () => {
    fixture = await createGitFixture();
    stack = await startStack({
      repositoryRoot: fixture.rootPath,
      reviewRevisionMaxObjects: 2,
    });
    await stack.authenticateOperator();
  });

  afterAll(async () => {
    if (stack !== undefined) await stack.close();
    if (fixture !== undefined) await fixture.close();
  });

  it("records an unavailable revision and no artifact when the closure exceeds its object limit", async () => {
    if (stack === undefined) throw new Error("Bounded local-source stack is unavailable");
    const inventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const repository = inventory.repositories[0];
    if (repository === undefined) throw new Error("Bounded repository is unavailable");
    const referencesResponse = await stack.fetchApi(
      `/api/v1/local-repository-sources/${repository.repositoryId}/references`,
    );
    expect(referencesResponse.status).toBe(200);

    const response = await stack.fetchApi("/api/v1/review-revisions", {
      body: JSON.stringify({
        repositoryId: repository.repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/review-source",
        changeIntent: "Prove bounded retention fails without publishing partial bytes",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(413);
    expect(ApiErrorSchema.parse(await response.json())).toMatchObject({
      code: "REVISION_LIMIT_EXCEEDED",
    });

    const persisted = JSON.parse(
      await stack.executeWebModule(`
        import { createPool } from '@kestrel/database';
        const pool = createPool(process.env.DATABASE_URL, 'kestrel-limit-observation-test');
        try {
          const result = await pool.query(
            "SELECT revision_state, failure_reason, artifact_locator, manifest_digest FROM review_revisions"
          );
          process.stdout.write(JSON.stringify(result.rows));
        } finally {
          await pool.end();
        }
      `),
    ) as Array<{
      artifact_locator: string | null;
      failure_reason: string;
      manifest_digest: string | null;
      revision_state: string;
    }>;
    expect(persisted).toEqual([
      {
        artifact_locator: null,
        failure_reason: "revision_limit_exceeded",
        manifest_digest: null,
        revision_state: "unavailable",
      },
    ]);

    await stack.executeRuntimeSql(`
      WITH material AS (
        SELECT rr.change_proposal_id,
               (SELECT max(version) + 1
                FROM change_intents
                WHERE change_proposal_id = rr.change_proposal_id) AS version,
               'Retry the bounded acquisition'::text AS intent_text,
               operator.id AS operator_id
        FROM review_revisions AS rr
        CROSS JOIN LATERAL (
          SELECT id FROM operators ORDER BY created_at, id LIMIT 1
        ) AS operator
      ),
      source AS (
        SELECT material.*,
               jsonb_build_array(
                 jsonb_build_object(
                   'id', 'operator_input',
                   'kind', 'operator_input',
                   'label', 'Operator input',
                   'text', material.intent_text,
                   'version', material.version::text,
                   'provenance', jsonb_build_object('kind', 'operator_input')
                 )
               ) AS selected_sources
        FROM material
      )
      INSERT INTO change_intents (
        change_proposal_id,
        version,
        intent_text,
        submitted_by_operator_id,
        objective,
        scope_boundaries,
        acceptance_outcomes,
        selected_sources,
        source_digest,
        resolution_state,
        resolution_issues
      )
      SELECT source.change_proposal_id,
             source.version,
             source.intent_text,
             source.operator_id,
             source.intent_text,
             '[]'::jsonb,
             '[]'::jsonb,
             source.selected_sources,
             encode(sha256(convert_to(source.selected_sources::text, 'UTF8')), 'hex'),
             'unresolved',
             '[{"kind":"missing","field":"scope_boundaries"},{"kind":"missing","field":"acceptance_outcomes"}]'::jsonb
      FROM source;

      UPDATE review_revisions
      SET revision_state = 'acquiring',
          acquisition_change_intent_id = (
            SELECT id FROM change_intents
            WHERE intent_text = 'Retry the bounded acquisition'
          ),
          failure_reason = NULL,
          updated_at = clock_timestamp();

      WITH material AS (
        SELECT rr.change_proposal_id,
               (SELECT max(version) + 1
                FROM change_intents
                WHERE change_proposal_id = rr.change_proposal_id) AS version,
               'Must not replace the in-flight acquisition intent'::text AS intent_text,
               operator.id AS operator_id
        FROM review_revisions AS rr
        CROSS JOIN LATERAL (
          SELECT id FROM operators ORDER BY created_at, id LIMIT 1
        ) AS operator
      ),
      source AS (
        SELECT material.*,
               jsonb_build_array(
                 jsonb_build_object(
                   'id', 'operator_input',
                   'kind', 'operator_input',
                   'label', 'Operator input',
                   'text', material.intent_text,
                   'version', material.version::text,
                   'provenance', jsonb_build_object('kind', 'operator_input')
                 )
               ) AS selected_sources
        FROM material
      )
      INSERT INTO change_intents (
        change_proposal_id,
        version,
        intent_text,
        submitted_by_operator_id,
        objective,
        scope_boundaries,
        acceptance_outcomes,
        selected_sources,
        source_digest,
        resolution_state,
        resolution_issues
      )
      SELECT source.change_proposal_id,
             source.version,
             source.intent_text,
             source.operator_id,
             source.intent_text,
             '[]'::jsonb,
             '[]'::jsonb,
             source.selected_sources,
             encode(sha256(convert_to(source.selected_sources::text, 'UTF8')), 'hex'),
             'unresolved',
             '[{"kind":"missing","field":"scope_boundaries"},{"kind":"missing","field":"acceptance_outcomes"}]'::jsonb
      FROM source;
    `);
    await expect(
      stack.executeRuntimeSql(`
        UPDATE review_revisions
        SET revision_state = 'unavailable',
            acquisition_change_intent_id = (
              SELECT id FROM change_intents
              WHERE intent_text = 'Must not replace the in-flight acquisition intent'
            ),
            failure_reason = 'object_missing',
            updated_at = clock_timestamp();
      `),
    ).rejects.toThrow("Review Revision acquisition intent is immutable outside retry");
    await stack.executeRuntimeSql(`
      UPDATE review_revisions
      SET revision_state = 'unavailable',
          failure_reason = 'object_missing',
          updated_at = clock_timestamp();
    `);
    const retryState = JSON.parse(
      await stack.executeWebModule(`
        import { createPool } from '@kestrel/database';
        const pool = createPool(process.env.DATABASE_URL, 'kestrel-intent-transition-test');
        try {
          const result = await pool.query(\`
            SELECT rr.revision_state AS "revisionState",
                   rr.failure_reason AS "failureReason",
                   rr.artifact_locator AS "artifactLocator",
                   ci.intent_text AS "acquisitionIntent"
            FROM review_revisions AS rr
            INNER JOIN change_intents AS ci ON ci.id = rr.acquisition_change_intent_id
          \`);
          process.stdout.write(JSON.stringify(result.rows[0]));
        } finally {
          await pool.end();
        }
      `),
    ) as Record<string, unknown>;
    expect(retryState).toEqual({
      acquisitionIntent: "Retry the bounded acquisition",
      artifactLocator: null,
      failureReason: "object_missing",
      revisionState: "unavailable",
    });
  });
});
