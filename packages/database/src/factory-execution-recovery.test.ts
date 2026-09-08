import { expect, it, vi } from "vitest";

import {
  recoverFactoryExecutions,
  type FactoryExecutionContainerRecovery,
} from "./factory-execution-recovery.js";

const projectId = "01991c36-7f90-7000-8000-000000000001";
const featureId = "01991c36-7f90-7000-8000-000000000002";
const runId = "01991c36-7f90-7000-8000-000000000003";
const itemId = "01991c36-7f90-7000-8000-000000000004";
const name = `kestrel-factory-${"1".repeat(32)}`;
const containerId = "a".repeat(64);
const daemonId = "c20f7230-59a2-4824-a2f4-fda71c982ee6";
const now = new Date("2026-09-08T12:00:00.000Z");

function fixture(id: string | null = containerId) {
  const feature = { id: featureId, project_id: projectId, state: "gated" };
  const run = {
    id: runId,
    feature_id: featureId,
    project_id: projectId,
    work_item_id: itemId,
    state: "interrupted",
    stop_requested_at: null as Date | null,
    reservation_released_at: null as Date | null,
    failure: "input_required",
    question: "Keep existing ordering?",
    owner_instance_id: itemId,
    plan_version: 3,
    accepted_commands: ["unchanged"],
    source: { identity: "unchanged" },
    revision: { headCommitId: "unchanged" },
  };
  const container = {
    name,
    container_id: id,
    daemon_id: daemonId,
    stopped_at: null as Date | null,
  };
  const containers = [container];
  let inTransaction = false;
  const events: string[] = [];
  const query = vi.fn((sql: string, parameters?: unknown[]) => {
    if (sql === "BEGIN") inTransaction = true;
    if (sql === "COMMIT" || sql === "ROLLBACK") inTransaction = false;
    if (sql === "COMMIT") events.push("commit");
    if (sql.includes("FROM factory_features") && sql.includes("FOR UPDATE"))
      return { rows: [{ ...feature }], rowCount: 1 };
    if (sql.includes("SELECT * FROM factory_execution_runs"))
      return { rows: [{ ...run }], rowCount: 1 };
    if (sql.includes("SET stop_requested_at")) {
      run.stop_requested_at ??= now;
      events.push("fenced");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT name, container_id,"))
      return {
        rows: containers
          .filter(
            (container) => !sql.includes("stopped_at IS NULL") || container.stopped_at === null,
          )
          .slice(0, 40)
          .map((container) => ({ ...container })),
        rowCount: containers.length,
      };
    if (sql.includes("UPDATE factory_execution_containers")) {
      const container = containers.find((entry) => entry.name === parameters?.[0]);
      if (
        !container ||
        (container.container_id !== null && container.container_id !== parameters?.[2])
      )
        return { rows: [], rowCount: 0 };
      if (sql.includes("SET container_id")) {
        if (container.stopped_at !== null) return { rows: [], rowCount: 0 };
        container.container_id = String(parameters?.[2]);
        events.push("identified");
      } else {
        if (container.container_id !== parameters?.[2]) return { rows: [], rowCount: 0 };
        container.stopped_at ??= now;
        events.push("stopped");
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE factory_execution_runs") && sql.includes("reservation_released_at")) {
      run.state = String(parameters?.[1]);
      run.failure = String(parameters?.[2]);
      run.reservation_released_at = now;
      events.push("released");
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return {
    feature,
    container,
    run,
    containers,
    query,
    events,
    inTransaction: () => inTransaction,
    pool: {
      query: vi.fn(() => ({
        rows:
          run.reservation_released_at === null
            ? [{ id: runId, feature_id: featureId, project_id: projectId }]
            : [],
      })),
      connect: () => ({ query, release: vi.fn() }),
    } as never,
  };
}

it("fences an orphan, persists identity before teardown, and releases without granting another attempt", async () => {
  const state = fixture(null);
  const recover = vi.fn<FactoryExecutionContainerRecovery>(
    async (container, onIdentified, signal) => {
      expect(state.run.stop_requested_at).toEqual(now);
      expect(state.inTransaction()).toBe(false);
      expect(signal.aborted).toBe(false);
      expect(container).toEqual({ name, id: null, daemonId });
      await onIdentified(containerId);
      expect(state.events.slice(-2)).toEqual(["identified", "commit"]);
      expect(state.containers[0]?.container_id).toBe(containerId);
      expect(state.run.reservation_released_at).toBeNull();
      return { name, id: containerId };
    },
  );
  const original = structuredClone(state.run);
  await expect(recoverFactoryExecutions(state.pool, recover)).resolves.toEqual([runId]);
  expect(state.containers[0]?.stopped_at).toEqual(now);
  expect(state.run).toMatchObject({
    state: "blocked",
    reservation_released_at: now,
    failure: original.failure,
    question: original.question,
    owner_instance_id: original.owner_instance_id,
    plan_version: original.plan_version,
    source: original.source,
    revision: original.revision,
    accepted_commands: original.accepted_commands,
  });
  expect(state.events.indexOf("stopped")).toBeLessThan(state.events.indexOf("released"));
  expect(
    state.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO factory_execution_runs")),
  ).toBe(false);
  await expect(recoverFactoryExecutions(state.pool, recover)).resolves.toEqual([]);
  expect(recover).toHaveBeenCalledOnce();
  expect(state.events.filter((event) => event === "released")).toHaveLength(1);
});

it("retains an uncertain reservation and retries teardown from a committed identity after restart", async () => {
  const state = fixture(null);
  await expect(
    recoverFactoryExecutions(state.pool, async (_container, onIdentified) => {
      await onIdentified(containerId);
      throw new Error("process died before recording teardown");
    }),
  ).resolves.toEqual([]);
  expect(state.containers[0]).toMatchObject({ container_id: containerId, stopped_at: null });
  expect(state.run.reservation_released_at).toBeNull();
  await expect(
    recoverFactoryExecutions(state.pool, async (container, onIdentified) => {
      expect(container.id).toBe(containerId);
      await onIdentified(containerId);
      return { name, id: containerId };
    }),
  ).resolves.toEqual([runId]);
});

it("does not release any slot while one persisted environment is uncertain", async () => {
  const state = fixture();
  state.containers.push({
    name: `${name}2`,
    container_id: null,
    daemon_id: daemonId,
    stopped_at: null,
  });
  await expect(
    recoverFactoryExecutions(state.pool, async (container, onIdentified) => {
      if (container.id === null) throw new Error("possibly delayed create");
      await onIdentified(container.id);
      return { name: container.name, id: container.id };
    }),
  ).resolves.toEqual([]);
  expect(state.containers[0]?.stopped_at).toEqual(now);
  expect(state.run.reservation_released_at).toBeNull();
});

it("releases an owned attempt with no reserved container only after the durable create fence commits", async () => {
  const state = fixture();
  state.containers.splice(0);
  const recover = vi.fn();
  await expect(recoverFactoryExecutions(state.pool, recover)).resolves.toEqual([runId]);
  expect(recover).not.toHaveBeenCalled();
  expect(state.run.stop_requested_at).toEqual(now);
  expect(state.run.reservation_released_at).toEqual(now);
  expect(state.events.indexOf("fenced")).toBeLessThan(state.events.indexOf("commit"));
  expect(state.events.indexOf("commit")).toBeLessThan(state.events.indexOf("released"));
});

it("releases a fenced attempt whose stopped lifecycle committed before the previous process died", async () => {
  const state = fixture();
  state.container.stopped_at = now;
  const recover = vi.fn();
  await expect(recoverFactoryExecutions(state.pool, recover)).resolves.toEqual([runId]);
  expect(recover).not.toHaveBeenCalled();
});

it("converges to cancellation if Stop arrives while orphan teardown is running", async () => {
  const state = fixture();
  await expect(
    recoverFactoryExecutions(state.pool, async (_container, onIdentified) => {
      await onIdentified(containerId);
      state.feature.state = "cancelled";
      state.run.state = "stopping";
      return { name, id: containerId };
    }),
  ).resolves.toEqual([runId]);
  expect(state.run).toMatchObject({
    state: "cancelled",
    failure: "cancelled",
    reservation_released_at: now,
  });
  expect(
    state.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO factory_human_gates")),
  ).toBe(false);
});

it("rejects a late identity callback after another owner has completed recovery", async () => {
  const state = fixture(null);
  let identityError: unknown;
  await expect(
    recoverFactoryExecutions(state.pool, async (_container, onIdentified) => {
      state.run.reservation_released_at = now;
      state.run.state = "blocked";
      await onIdentified(containerId).catch((error: unknown) => {
        identityError = error;
      });
      throw new Error("late recovery must not stop anything");
    }),
  ).resolves.toEqual([]);
  expect(identityError).toMatchObject({ code: "conflict" });
  expect(state.containers[0]?.container_id).toBeNull();
  expect(state.events).not.toContain("released");
});

it("does not persist a stop proof for an identity that changed during teardown", async () => {
  const state = fixture();
  await expect(
    recoverFactoryExecutions(state.pool, async (_container, onIdentified) => {
      await onIdentified(containerId);
      state.container.container_id = "b".repeat(64);
      return { name, id: containerId };
    }),
  ).resolves.toEqual([]);
  expect(state.container.container_id).toBe("b".repeat(64));
  expect(state.containers[0]?.stopped_at).toBeNull();
  expect(state.run.reservation_released_at).toBeNull();
});

it.each(["running", "verifying", "verified", "blocked"])(
  "rechecks the attempt state under lock before teardown (%s)",
  async (runState) => {
    const state = fixture();
    state.run.state = runState;
    const recover = vi.fn();
    await expect(recoverFactoryExecutions(state.pool, recover)).resolves.toEqual([]);
    expect(recover).not.toHaveBeenCalled();
    expect(state.run.stop_requested_at).toBeNull();
    expect(state.run.reservation_released_at).toBeNull();
  },
);

it("recovers a large final verification lifecycle in bounded batches without replaying reviewed Work Items", async () => {
  const state = fixture();
  Object.assign(state.run, { purpose: "feature_verification", work_item_id: null });
  state.containers.splice(
    0,
    1,
    ...Array.from({ length: 1442 }, (_, index) => ({
      name: `kestrel-factory-${index.toString(16).padStart(32, "0")}`,
      container_id: index.toString(16).padStart(64, "0"),
      daemon_id: daemonId,
      stopped_at: index < 1367 ? now : null,
    })),
  );
  const recover = vi.fn<FactoryExecutionContainerRecovery>((container) => {
    if (container.id === null) throw new Error("Missing container identity");
    return Promise.resolve({ name: container.name, id: container.id });
  });
  expect(await recoverFactoryExecutions(state.pool, recover)).toEqual([]);
  expect(recover).toHaveBeenCalledTimes(40);
  expect(state.run.reservation_released_at).toBeNull();
  expect(await recoverFactoryExecutions(state.pool, recover)).toEqual([runId]);
  expect(recover).toHaveBeenCalledTimes(75);
  expect(state.query.mock.calls.some(([sql]) => sql.includes("UPDATE factory_work_items"))).toBe(
    false,
  );
  expect(state.run.accepted_commands).toEqual(["unchanged"]);
});
