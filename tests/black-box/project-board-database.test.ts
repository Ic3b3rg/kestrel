import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import {
  createPool,
  migrate,
  verifyAppliedMigrations,
  createFactoryFeature,
  enqueueProjectIssue,
  findProjectIssueStart,
  readProjectIssueStarts,
  saveProjectBoardSettings,
  readProjectBoardSettings,
  saveProjectIssueObservation,
  readProjectIssueObservation,
  changeIssueDispatch,
  readIssueDispatches,
  attachIssueDispatchFeature,
  retainIssueDispatchContext,
  readIssueExecutionContext,
  issueProjectBusy,
  type DatabasePool,
} from "@kestrel/database";
import type { FactoryGitHubIssue } from "@kestrel/contracts";

const exec = promisify(execFile);

it("migrates a clean database, persists board state, deduplicates starts and dispatches per Project", async () => {
  const docker = process.env.KESTREL_DOCKER_EXECUTABLE ?? "docker";
  const name = `kestrel-board-test-${randomUUID()}`;
  const password = randomUUID();
  let pool: DatabasePool | undefined;
  try {
    await exec(docker, [
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--label",
      "kestrel.owner=project-board-test",
      "--publish",
      "127.0.0.1::5432",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "postgres:18.6-alpine",
    ]);
    const { stdout } = await exec(docker, ["port", name, "5432/tcp"]);
    const port = stdout.trim().split(":").at(-1);
    if (port === undefined) throw new Error("Missing fixture database port");
    const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
    pool = createPool(url, name);
    for (let attempt = 0; ; attempt++) {
      try {
        await pool.query("SELECT 1");
        break;
      } catch (error) {
        if (attempt >= 40) throw error;
        await delay(250);
      }
    }
    await pool.query("CREATE SCHEMA pgboss");
    await migrate(pool);
    await verifyAppliedMigrations(pool);
    const actor = "01991c36-7f90-7000-8000-000000000003";
    await pool.query(
      "INSERT INTO operators(id,username,password_hash) VALUES($1,'board-test',$2)",
      [actor, "$argon2id$v=19$" + "x".repeat(80)],
    );
    const project = "01991c36-7f90-7000-8000-000000000001";
    const other = "01991c36-7f90-7000-8000-000000000002";
    for (const id of [project, other])
      await pool.query(
        `INSERT INTO projects(id,installation_id,provider_observation_kind,provider,provider_repository_id,repository_owner_snapshot,repository_name_snapshot,repository_canonical_url_snapshot)
       SELECT $1::uuid,id,'public_github','github',$1::text,'example','reports','https://github.com/example/reports' FROM installations`,
        [id],
      );
    const issue: FactoryGitHubIssue = {
      repository: { id: "901", owner: "example", name: "reports" },
      id: "42",
      number: 42,
      url: "https://github.com/example/reports/issues/42",
      title: "Export",
      body: "Current requirements",
      state: "open",
      dependencies: [],
      labels: [{ name: "ship", color: "008800" }],
      commentCount: 1,
    };
    expect(await readProjectBoardSettings(pool, project)).toEqual({
      readyLabel: "ready-for-agent",
    });
    const command = { requestId: randomUUID(), issueNumber: 42 };
    await expect(enqueueProjectIssue(pool, project, actor, command, issue)).rejects.toMatchObject({
      code: "conflict",
    });
    await saveProjectBoardSettings(pool, project, { readyLabel: "ship" });
    await saveProjectIssueObservation(pool, project, "catalog", { issues: [issue] });
    const activePool = pool;
    const ids = await Promise.all(
      Array.from({ length: 4 }, () =>
        enqueueProjectIssue(activePool, project, actor, command, issue),
      ),
    );
    expect(new Set(ids).size).toBe(1);
    const id = ids[0];
    if (id === undefined) throw new Error("Missing start");
    await expect(
      enqueueProjectIssue(pool, project, actor, { ...command, requestId: randomUUID() }, issue),
    ).rejects.toMatchObject({ code: "conflict" });
    await pool.end();
    pool = createPool(url, name);
    expect(await findProjectIssueStart(pool, project, actor, command)).toBe(id);
    expect(await readProjectBoardSettings(pool, project)).toEqual({ readyLabel: "ship" });
    expect(await readProjectIssueObservation(pool, project, "catalog")).toEqual({
      issues: [issue],
    });
    expect(await readProjectIssueStarts(pool, project)).toHaveLength(1);
    await changeIssueDispatch(pool, project, id, "cancel");
    const restarted = await enqueueProjectIssue(
      pool,
      project,
      actor,
      { ...command, requestId: randomUUID() },
      issue,
    );
    expect(restarted).not.toBe(id);
    const feature = await createFactoryFeature(pool, project, actor, {
      requestId: randomUUID(),
      title: "Export",
    });
    await attachIssueDispatchFeature(pool, restarted, feature.id);
    const snapshot = { issue, conversation: [{ body: "Keep Unicode" }] };
    await retainIssueDispatchContext(pool, restarted, snapshot);
    expect(await readIssueExecutionContext(pool, feature.id)).toEqual(snapshot);
    // Older blocked requests in one Project must not hide another Project's head.
    await pool.query("UPDATE project_issue_starts SET state='blocked' WHERE id=$1", [restarted]);
    await pool.query(
      `INSERT INTO project_issue_starts(project_id,actor_id,request_id,repository_id,issue_id,issue_number,issue_url,title,ready_label)
      SELECT $1,$2,uuidv7(),'901',n::text,n,'https://github.com/example/reports/issues/'||n,'Queued','ship' FROM generate_series(100,305) n`,
      [project, actor],
    );
    await saveProjectBoardSettings(pool, other, { readyLabel: "ship" });
    const otherId = await enqueueProjectIssue(
      pool,
      other,
      actor,
      { requestId: randomUUID(), issueNumber: 43 },
      { ...issue, id: "43", number: 43, url: issue.url.replace("42", "43") },
    );
    expect((await readIssueDispatches(pool)).map((row) => row.id)).toEqual(
      expect.arrayContaining([restarted, otherId]),
    );
    expect(await readIssueDispatches(pool)).toHaveLength(2);
    await pool.query("UPDATE factory_features SET state='in_review' WHERE id=$1", [feature.id]);
    const ready = await readIssueDispatches(pool);
    expect(ready).toHaveLength(3);
    const next = ready.find((row) => row.project_id === project && row.id !== restarted);
    if (next === undefined) throw new Error("Missing next Project issue");
    expect(await issueProjectBusy(pool, next)).toBe(false);
    await pool.query("UPDATE factory_features SET state='implementing' WHERE id=$1", [feature.id]);
    expect(await issueProjectBusy(pool, next)).toBe(true);
  } finally {
    await pool?.end();
    await exec(docker, ["rm", "--force", name]).catch(() => undefined);
  }
}, 60_000);
