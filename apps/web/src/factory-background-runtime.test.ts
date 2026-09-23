import type * as changeOverviewRendererModule from "./change-overview-renderer.js";
import type * as publicationProcessorModule from "./factory-publication.js";
import type * as planningProcessorModule from "./factory-planning.js";
import type * as featurePublicationProcessorModule from "./factory-feature-publication.js";
import type * as featureMergeProcessorModule from "./factory-feature-merge-processor.js";
import type * as reviewCorrectionProcessorModule from "./factory-review-correction-processor.js";
import type * as conceptualReviewProcessorModule from "./conceptual-review-processor.js";
import type * as executionProcessorModule from "./factory-execution-processor.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as database from "@kestrel/database";
import { FileCredentialStore, createOpenAiTransport } from "@kestrel/model-provider";
import type { LocalSourceConfig } from "@kestrel/local-source";
import { reconcileFactorySandboxes } from "./factory-sandbox.js";
import { createDatabaseFactoryConceptualReviewService } from "./routes/factory-conceptual-review.js";
import { createFactoryBackgroundRuntime } from "./factory-background-runtime.js";

const processors = vi.hoisted(() => ({ process: vi.fn(), stop: vi.fn() }));
vi.mock("@kestrel/database", async (original) => ({
  ...(await original<typeof database>()),
  reconcilePlanningTurns: vi.fn(),
  reconcileFactoryPublications: vi.fn(),
  reconcileFactoryFeaturePublications: vi.fn(),
  reconcileFactoryConceptualReviewWorkflows: vi.fn(),
  reconcileFactoryReviewCorrections: vi.fn(),
  reconcileFactoryFeatureMerges: vi.fn(),
}));
vi.mock("./factory-sandbox.js", () => ({ reconcileFactorySandboxes: vi.fn() }));
vi.mock("./factory-execution-processor.js", async (original) => ({
  ...(await original<typeof executionProcessorModule>()),
  createFactoryExecutionProcessor: () => processors,
}));
vi.mock("./conceptual-review-processor.js", async (original) => ({
  ...(await original<typeof conceptualReviewProcessorModule>()),
  createFactoryConceptualReviewProcessor: () => processors,
}));
vi.mock("./factory-review-correction-processor.js", async (original) => ({
  ...(await original<typeof reviewCorrectionProcessorModule>()),
  createFactoryReviewCorrectionProcessor: () => processors,
}));
vi.mock("./factory-feature-merge-processor.js", async (original) => ({
  ...(await original<typeof featureMergeProcessorModule>()),
  createFactoryFeatureMergeProcessor: () => processors,
}));
vi.mock("./factory-feature-publication.js", async (original) => ({
  ...(await original<typeof featurePublicationProcessorModule>()),
  createFactoryFeaturePublicationProcessor: () => processors,
}));
vi.mock("./factory-planning.js", async (original) => ({
  ...(await original<typeof planningProcessorModule>()),
  createFactoryPlanningProcessor: () => processors,
}));
vi.mock("./factory-publication.js", async (original) => ({
  ...(await original<typeof publicationProcessorModule>()),
  createFactoryPublicationProcessor: () => processors,
}));
vi.mock("./change-overview-renderer.js", async (original) => ({
  ...(await original<typeof changeOverviewRendererModule>()),
  createChangeOverviewRenderer: () => processors,
}));

const config: LocalSourceConfig = {
  artifactRoot: "/tmp/kestrel-runtime-lifecycle-test",
  gitExecutable: "git",
  gitObjectReadTimeoutMs: 1000,
  maxBytes: 1000,
  maxObjects: 100,
  repositoryRoots: [],
};
const repairs = [
  database.reconcilePlanningTurns,
  database.reconcileFactoryPublications,
  reconcileFactorySandboxes,
  database.reconcileFactoryConceptualReviewWorkflows,
  database.reconcileFactoryReviewCorrections,
  database.reconcileFactoryFeatureMerges,
  database.reconcileFactoryFeaturePublications,
];
const pools: database.DatabasePool[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  processors.stop.mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.useRealTimers();
  for (const pool of pools.splice(0)) await pool.end();
  vi.restoreAllMocks();
});
function fixture() {
  const pool = database.createPool("postgres://unused:unused@127.0.0.1/unused", "runtime-test");
  pools.push(pool);
  const boss = database.createPgBoss({
    databaseUrl: "postgres://unused:unused@127.0.0.1/unused",
    applicationName: "runtime-test",
  });
  const start = vi.spyOn(boss, "start").mockResolvedValue(boss);
  const work = vi.spyOn(boss, "work").mockResolvedValue("consumer");
  const offWork = vi.spyOn(boss, "offWork").mockResolvedValue(undefined);
  const stop = vi.spyOn(boss, "stop").mockResolvedValue(undefined);
  const log = { error: vi.fn(), info: vi.fn() };
  const runtime = createFactoryBackgroundRuntime({
    pool,
    boss,
    log,
    localSourceConfig: config,
    readSourceConfig: () => Promise.resolve(config),
    credentialStore: new FileCredentialStore("/tmp/kestrel-runtime-lifecycle-test/secrets"),
    transport: createOpenAiTransport(),
    conceptualReview: createDatabaseFactoryConceptualReviewService(pool, () =>
      Promise.resolve(config),
    ),
    conceptualReviewRuntimeProfile: null,
  });
  return { runtime, start, work, offWork, stop, log };
}

it("repairs durable state before intake and registers each consumer only once", async () => {
  const repairing = Promise.withResolvers<undefined>();
  vi.mocked(database.reconcilePlanningTurns).mockReturnValueOnce(repairing.promise);
  const f = fixture();
  const starting = f.runtime.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.work).not.toHaveBeenCalled();
  repairing.resolve(undefined);
  await Promise.all([starting, f.runtime.start()]);
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(new Set(f.work.mock.calls.map(([queue]) => queue)).size).toBe(8);
  expect(f.work).toHaveBeenCalledTimes(8);
  for (const repair of repairs) expect(repair).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(6);
  await f.runtime.stop();
  expect(f.offWork).toHaveBeenCalledTimes(8);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not overlap publication repair and drains it before closing the queue", async () => {
  const f = fixture();
  await f.runtime.start();
  const repairing = Promise.withResolvers<undefined>();
  vi.mocked(database.reconcileFactoryPublications).mockReturnValueOnce(repairing.promise);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(database.reconcileFactoryPublications).toHaveBeenCalledTimes(2);
  let drained = false;
  const stopping = f.runtime.stop().then(() => {
    drained = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(processors.stop).toHaveBeenCalledTimes(5);
  expect(f.stop).not.toHaveBeenCalled();
  expect(drained).toBe(false);
  repairing.resolve(undefined);
  await stopping;
  await f.runtime.stop();
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("retries periodic repair after a logged failure without duplicating consumers", async () => {
  const f = fixture();
  await f.runtime.start();
  vi.mocked(reconcileFactorySandboxes).mockRejectedValueOnce(new Error("probe unavailable"));
  await vi.advanceTimersByTimeAsync(4_000);
  expect(reconcileFactorySandboxes).toHaveBeenCalledTimes(3);
  expect(f.log.error).toHaveBeenCalledWith(
    expect.objectContaining({ event: "factory.execution_reconciliation_failed" }),
  );
  expect(f.work).toHaveBeenCalledTimes(8);
  await f.runtime.stop();
});

it("does not open intake after a startup repair failure", async () => {
  vi.mocked(database.reconcileFactoryPublications).mockRejectedValueOnce(
    new Error("database unavailable"),
  );
  const f = fixture();
  await expect(f.runtime.start()).rejects.toThrow("database unavailable");
  await f.runtime.stop({ graceful: false });
  expect(f.work).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledWith({ graceful: false });
  expect(vi.getTimerCount()).toBe(0);
});

it("stops a startup in progress before subsequent repair or consumer registration", async () => {
  const repairing = Promise.withResolvers<undefined>();
  vi.mocked(database.reconcilePlanningTurns).mockReturnValueOnce(repairing.promise);
  const f = fixture();
  const starting = f.runtime.start();
  await vi.advanceTimersByTimeAsync(0);
  const stopping = f.runtime.stop();
  expect(f.stop).not.toHaveBeenCalled();
  repairing.resolve(undefined);
  await Promise.all([starting, stopping]);
  expect(database.reconcileFactoryPublications).not.toHaveBeenCalled();
  expect(f.work).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledTimes(1);
  await expect(f.runtime.start()).rejects.toThrow("stopped");
});

it("drains registered consumers when a later registration fails", async () => {
  const f = fixture();
  f.work.mockResolvedValueOnce("first").mockRejectedValueOnce(new Error("registration failed"));
  await expect(f.runtime.start()).rejects.toThrow("registration failed");
  await f.runtime.stop({ graceful: false });
  expect(f.offWork).toHaveBeenCalledExactlyOnceWith(database.FACTORY_PUBLICATION_QUEUE);
  expect(f.stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("finishes other drains and closes the queue even when a processor stop rejects", async () => {
  const f = fixture();
  await f.runtime.start();
  processors.stop.mockRejectedValueOnce(new Error("stop proof unavailable"));
  await expect(f.runtime.stop()).rejects.toThrow("Factory background shutdown failed");
  expect(f.offWork).toHaveBeenCalledTimes(8);
  expect(f.stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("delivers an already fetched planning job during shutdown so its processor can settle interruption", async () => {
  const f = fixture();
  await f.runtime.start();
  const consume = f.work.mock.calls.find(
    ([queue]) => queue === database.FACTORY_PLANNING_QUEUE,
  )?.[2];
  if (consume === undefined) throw new Error("Missing planning consumer");
  const delivered = Promise.withResolvers<undefined>();
  f.offWork.mockReturnValue(delivered.promise);
  const stopping = f.runtime.stop();
  await consume([
    {
      id: "planning-job",
      name: database.FACTORY_PLANNING_QUEUE,
      data: { turnId: "planning-turn" },
      expireInSeconds: 180,
      heartbeatSeconds: null,
      signal: new AbortController().signal,
    },
  ]);
  expect(processors.process).toHaveBeenCalledExactlyOnceWith(
    { turnId: "planning-turn" },
    expect.objectContaining({ aborted: true }),
  );
  delivered.resolve(undefined);
  await stopping;
});

it("drains a fetched non-interruptible rendering with its original job signal during shutdown", async () => {
  const f = fixture();
  await f.runtime.start();
  const consume = f.work.mock.calls.find(
    ([queue]) => queue === database.CHANGE_OVERVIEW_RENDER_QUEUE,
  )?.[2];
  if (consume === undefined) throw new Error("Missing rendering consumer");
  const delivered = Promise.withResolvers<undefined>();
  f.offWork.mockReturnValue(delivered.promise);
  const stopping = f.runtime.stop();
  await consume([
    {
      id: "rendering-job",
      name: database.CHANGE_OVERVIEW_RENDER_QUEUE,
      data: { revisionId: "revision" },
      expireInSeconds: 120,
      heartbeatSeconds: null,
      signal: new AbortController().signal,
    },
  ]);
  expect(processors.process).toHaveBeenCalledExactlyOnceWith({ revisionId: "revision" });
  expect(f.log.info).toHaveBeenCalledWith(
    expect.objectContaining({ event: "change_overview.rendering_finished" }),
  );
  delivered.resolve(undefined);
  await stopping;
});
