import { FactoryExecutionFailureSchema } from "@kestrel/contracts";
import type { PoolClient } from "pg";

import { ensureFactoryGate } from "./factory-gates.js";
import { FactoryError, withFactoryFeature, type FeatureRow } from "./factory-planning.js";
import type { DatabasePool } from "./pool.js";

export type FactoryExecutionContainerRecovery = (
  container: { name: string; id: string | null; daemonId: string | null },
  onIdentified: (id: string) => Promise<void>,
  signal: AbortSignal,
) => Promise<{ name: string; id: string }>;

interface RunIdentity {
  id: string;
  feature_id: string;
  project_id: string;
}
interface RecoveryRun extends RunIdentity {
  work_item_id: string | null;
  purpose?: "work_item" | "feature_verification";
  state: string;
  stop_requested_at: Date | null;
  reservation_released_at: Date | null;
  failure: string | null;
  question: string | null;
}
interface ContainerRow {
  name: string;
  container_id: string | null;
  daemon_id: string | null;
  stopped_at: Date | null;
}

async function withFencedRun<T>(
  pool: DatabasePool,
  identity: RunIdentity,
  operation: (client: PoolClient, run: RecoveryRun, feature: FeatureRow) => Promise<T>,
): Promise<T | undefined> {
  return withFactoryFeature(
    pool,
    identity.project_id,
    identity.feature_id,
    async (client, feature) => {
      const result = await client.query<RecoveryRun>(
        "SELECT * FROM factory_execution_runs WHERE id = $1 AND feature_id = $2 FOR UPDATE",
        [identity.id, identity.feature_id],
      );
      const run = result.rows[0];
      if (
        run === undefined ||
        run.reservation_released_at !== null ||
        !["interrupted", "stopping"].includes(run.state)
      )
        return undefined;
      // All container reservations take this same Feature/run lock. After this commit,
      // a delayed original owner can identify its existing create but cannot reserve another.
      if (run.stop_requested_at === null)
        await client.query(
          "UPDATE factory_execution_runs SET stop_requested_at = COALESCE(stop_requested_at, clock_timestamp()) WHERE id = $1",
          [run.id],
        );
      return operation(client, run, feature);
    },
  );
}

async function containersFor(client: PoolClient, runId: string): Promise<ContainerRow[]> {
  const result = await client.query<ContainerRow>(
    "SELECT name, container_id, daemon_id, stopped_at FROM factory_execution_containers WHERE run_id = $1 AND stopped_at IS NULL ORDER BY created_at, name LIMIT 40 FOR UPDATE",
    [runId],
  );
  return result.rows;
}

/** Recover only terminated attempts; a heartbeat expiry alone never releases writer authority. */
export async function recoverFactoryExecutions(
  pool: DatabasePool,
  recover: FactoryExecutionContainerRecovery,
): Promise<string[]> {
  // Factory 0.1 admits at most two Project reservations. Each gets a ten-second
  // teardown budget, with no database locks held while Docker is contacted.
  const candidates = await pool.query<RunIdentity>(
    `SELECT id, feature_id, project_id FROM factory_execution_runs
     WHERE reservation_released_at IS NULL AND state IN ('interrupted', 'stopping')
     ORDER BY created_at, id LIMIT 2`,
  );
  const released: string[] = [];
  for (const candidate of candidates.rows) {
    const containers = await withFencedRun(pool, candidate, (client, run) =>
      containersFor(client, run.id),
    );
    if (containers === undefined) continue;
    const deadline = AbortSignal.timeout(10_000);
    for (const container of containers) {
      if (deadline.aborted) break;
      if (container.stopped_at !== null) continue;
      try {
        const stopped = await recover(
          {
            name: container.name,
            id: container.container_id,
            daemonId: container.daemon_id ?? null,
          },
          async (id) => {
            if (!/^[a-f0-9]{64}$/u.test(id)) throw new FactoryError("conflict");
            const identified = await withFencedRun(pool, candidate, async (client, run) => {
              const result = await client.query(
                `UPDATE factory_execution_containers SET container_id = $3
                 WHERE name = $1 AND run_id = $2 AND stopped_at IS NULL
                   AND (container_id IS NULL OR container_id = $3)`,
                [container.name, run.id, id],
              );
              return result.rowCount === 1;
            });
            if (identified !== true) throw new FactoryError("conflict");
          },
          deadline,
        );
        if (
          stopped.name !== container.name ||
          !/^[a-f0-9]{64}$/u.test(stopped.id) ||
          (container.container_id !== null && stopped.id !== container.container_id)
        )
          continue;
        await withFencedRun(pool, candidate, async (client, run) => {
          // An identity found by name must have committed before teardown. Never
          // adopt a returned ID here or overwrite another owner's stopped witness.
          await client.query(
            `UPDATE factory_execution_containers SET stopped_at = COALESCE(stopped_at, clock_timestamp())
             WHERE name = $1 AND run_id = $2 AND container_id = $3`,
            [container.name, run.id, stopped.id],
          );
        });
      } catch {
        // A failed probe, a delayed create, or a raced callback retains authority.
        // A later pass can use the identity committed before a partial teardown.
      }
    }
    const didRelease = await withFencedRun(pool, candidate, async (client, run, feature) => {
      const current = await containersFor(client, run.id);
      if (current.some((container) => container.stopped_at === null)) return false;
      // An empty lifecycle is also a proof: every create awaits its durable
      // reservation, and the committed stop fence rejects all later reservations.
      const cancelled = feature.state === "cancelled";
      const failure = cancelled
        ? "cancelled"
        : FactoryExecutionFailureSchema.parse(run.failure ?? "interrupted");
      await client.query(
        `UPDATE factory_execution_runs SET state = $2, failure = $3,
         completed_at = COALESCE(completed_at, clock_timestamp()), reservation_released_at = clock_timestamp()
         WHERE id = $1`,
        [run.id, cancelled ? "cancelled" : "blocked", failure],
      );
      if (run.purpose !== "feature_verification")
        await client.query("UPDATE factory_work_items SET board_column = 'todo' WHERE id = $1", [
          run.work_item_id,
        ]);
      if (!cancelled) {
        await client.query(
          "UPDATE factory_features SET state = 'gated', updated_at = clock_timestamp() WHERE id = $1",
          [run.feature_id],
        );
        await ensureFactoryGate(client, run.id, failure, run.question);
      }
      await client.query(
        "INSERT INTO factory_activity (feature_id, work_item_id, kind, summary) VALUES ($1,$2,'execution_blocked',$3)",
        [
          run.feature_id,
          run.work_item_id,
          cancelled
            ? "The cancelled execution environment has been stopped."
            : "The execution environment has been stopped. Inspect the retained attempt and answer its Human Gate before continuing.",
        ],
      );
      return true;
    });
    if (didRelease === true) released.push(candidate.id);
  }
  return released;
}
