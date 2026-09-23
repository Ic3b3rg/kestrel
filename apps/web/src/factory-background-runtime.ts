import { createCodexExecutionContainerRecovery } from "./codex-execution-runtime.js";
import { reconcileFactorySandboxes } from "./factory-sandbox.js";
import {
  createFactoryExecutionProcessor,
  FACTORY_EXECUTION_WORK_OPTIONS,
} from "./factory-execution-processor.js";
import {
  createFactoryConceptualReviewProcessor,
  FACTORY_CONCEPTUAL_REVIEW_WORK_OPTIONS,
} from "./conceptual-review-processor.js";
import {
  createFactoryReviewCorrectionProcessor,
  FACTORY_REVIEW_CORRECTION_WORK_OPTIONS,
} from "./factory-review-correction-processor.js";
import {
  createFactoryFeatureMergeProcessor,
  FACTORY_FEATURE_MERGE_WORK_OPTIONS,
} from "./factory-feature-merge-processor.js";
import {
  createFactoryPublicationProcessor,
  FACTORY_PUBLICATION_WORK_OPTIONS,
} from "./factory-publication.js";
import {
  createFactoryFeaturePublicationProcessor,
  FACTORY_FEATURE_PUBLICATION_WORK_OPTIONS,
} from "./factory-feature-publication.js";
import { createFactoryFeatureRevisionRetainer } from "./factory-feature-revision.js";
import {
  createFactoryPlanningProcessor,
  FACTORY_PLANNING_WORK_OPTIONS,
} from "./factory-planning.js";
import {
  CHANGE_OVERVIEW_RENDER_WORK_OPTIONS,
  createChangeOverviewRenderer,
  createDatabaseChangeOverviewRenderingPersistence,
} from "./change-overview-renderer.js";
import {
  CHANGE_OVERVIEW_RENDER_QUEUE,
  FACTORY_PLANNING_QUEUE,
  FACTORY_PUBLICATION_QUEUE,
  FACTORY_FEATURE_PUBLICATION_QUEUE,
  FACTORY_EXECUTION_QUEUE,
  FACTORY_CONCEPTUAL_REVIEW_QUEUE,
  FACTORY_CORRECTION_QUEUE,
  FACTORY_MERGE_QUEUE,
  reconcilePlanningTurns,
  reconcileFactoryPublications,
  reconcileFactoryFeaturePublications,
  reconcileFactoryConceptualReviewWorkflows,
  reconcileFactoryReviewCorrections,
  reconcileFactoryFeatureMerges,
  type createPgBoss,
  type DatabasePool,
} from "@kestrel/database";
import {
  disposeConceptualReviewAttemptResources,
  type LocalSourceConfig,
} from "@kestrel/local-source";
import type { CredentialStore, OpenAiTransport } from "@kestrel/model-provider";
import type { FastifyBaseLogger } from "fastify";
import type {
  createDatabaseFactoryConceptualReviewService,
  FactoryConceptualReviewService,
} from "./routes/factory-conceptual-review.js";

interface Options {
  pool: DatabasePool;
  boss: ReturnType<typeof createPgBoss>;
  log: Pick<FastifyBaseLogger, "error" | "info">;
  localSourceConfig: LocalSourceConfig;
  readSourceConfig: () => Promise<LocalSourceConfig>;
  credentialStore: Pick<CredentialStore, "read">;
  transport: OpenAiTransport;
  conceptualReview: FactoryConceptualReviewService;
  conceptualReviewRuntimeProfile: NonNullable<
    Parameters<typeof createDatabaseFactoryConceptualReviewService>[2]
  >["runtimeProfile"];
  containerImage?: string;
  dockerExecutable?: string;
}

/** Owns Factory background work; the web host retains HTTP and its shared database pools. */
export function createFactoryBackgroundRuntime({
  pool,
  boss,
  log,
  localSourceConfig,
  readSourceConfig,
  credentialStore,
  transport: openAiTransport,
  conceptualReview: factoryConceptualReviewService,
  conceptualReviewRuntimeProfile: factoryConceptualReviewRuntimeProfile,
  containerImage: factoryExecutionImage,
  dockerExecutable: factoryDockerExecutable,
}: Options) {
  const changeOverviewRenderer = createChangeOverviewRenderer({
    credentialStore,
    persistence: createDatabaseChangeOverviewRenderingPersistence(pool),
    transport: openAiTransport,
  });
  const planningProcessor = createFactoryPlanningProcessor({
    pool,
    readSourceConfig,
  });
  const publicationProcessor = createFactoryPublicationProcessor({ pool });
  const featureRevisionRetainer = createFactoryFeatureRevisionRetainer({
    pool,
    readSourceConfig,
    renderingCoordinator: boss,
  });
  const featurePublicationProcessor = createFactoryFeaturePublicationProcessor({
    pool,
    readSourceConfig,
    retain: featureRevisionRetainer,
  });
  const reviewCorrectionProcessor = createFactoryReviewCorrectionProcessor({
    pool,
    readSourceConfig,
    retain: featureRevisionRetainer,
    review: factoryConceptualReviewService,
  });
  const featureMergeProcessor = createFactoryFeatureMergeProcessor({ pool, boss });
  const recoverExecutionContainer = createCodexExecutionContainerRecovery(
    factoryDockerExecutable === undefined ? {} : { dockerExecutable: factoryDockerExecutable },
  );
  const executionProcessor = createFactoryExecutionProcessor({
    pool,
    readSourceConfig,
    ...(factoryExecutionImage === undefined ? {} : { containerImage: factoryExecutionImage }),
    ...(factoryDockerExecutable === undefined ? {} : { dockerExecutable: factoryDockerExecutable }),
  });
  const conceptualReviewProcessor = createFactoryConceptualReviewProcessor({
    pool,
    boss,
    readSourceConfig,
    ...(factoryExecutionImage === undefined ? {} : { containerImage: factoryExecutionImage }),
    ...(factoryDockerExecutable === undefined ? {} : { dockerExecutable: factoryDockerExecutable }),
    ...(factoryConceptualReviewRuntimeProfile == null
      ? {}
      : {
          codexExecutable: factoryConceptualReviewRuntimeProfile.codexExecutable,
          codexExecutableDigest: factoryConceptualReviewRuntimeProfile.codexExecutableDigest,
          codexVersion: factoryConceptualReviewRuntimeProfile.codexVersion,
          containerUser: factoryConceptualReviewRuntimeProfile.containerUser,
        }),
  });

  const lifecycle = new AbortController();
  const isStopped = () => lifecycle.signal.aborted;
  const timers: NodeJS.Timeout[] = [];
  const activeRepairs = new Set<Promise<void>>();
  const consumers: string[] = [];
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const logQueueError = (error: Error) => log.error({ err: error, event: "pgboss.error" });

  const reconcileExecution = () =>
    reconcileFactorySandboxes(
      pool,
      boss,
      factoryDockerExecutable === undefined ? {} : { dockerExecutable: factoryDockerExecutable },
    );
  const reconcileReview = () =>
    reconcileFactoryConceptualReviewWorkflows(pool, boss, recoverExecutionContainer, (attemptId) =>
      disposeConceptualReviewAttemptResources(localSourceConfig, attemptId),
    );
  const repairs = [
    {
      run: () => reconcileFactoryPublications(pool, boss),
      interval: 5_000,
      event: "factory.publication_reconciliation_failed",
    },
    { run: reconcileExecution, interval: 2_000, event: "factory.execution_reconciliation_failed" },
    {
      run: reconcileReview,
      interval: 2_000,
      event: "factory.conceptual_review_reconciliation_failed",
    },
    {
      run: () => reconcileFactoryReviewCorrections(pool, boss),
      interval: 2_000,
      event: "factory.review_correction_reconciliation_failed",
    },
    {
      run: () => reconcileFactoryFeatureMerges(pool, boss),
      interval: 2_000,
      event: "factory.feature_merge_reconciliation_failed",
    },
    {
      run: () => reconcileFactoryFeaturePublications(pool, boss),
      interval: 5_000,
      event: "factory.feature_publication_reconciliation_failed",
    },
  ];
  const queues = [
    [FACTORY_PUBLICATION_QUEUE, FACTORY_PUBLICATION_WORK_OPTIONS, publicationProcessor],
    [FACTORY_PLANNING_QUEUE, FACTORY_PLANNING_WORK_OPTIONS, planningProcessor],
    [
      FACTORY_FEATURE_PUBLICATION_QUEUE,
      FACTORY_FEATURE_PUBLICATION_WORK_OPTIONS,
      featurePublicationProcessor,
    ],
    [FACTORY_EXECUTION_QUEUE, FACTORY_EXECUTION_WORK_OPTIONS, executionProcessor],
    [
      FACTORY_CONCEPTUAL_REVIEW_QUEUE,
      FACTORY_CONCEPTUAL_REVIEW_WORK_OPTIONS,
      conceptualReviewProcessor,
    ],
    [FACTORY_CORRECTION_QUEUE, FACTORY_REVIEW_CORRECTION_WORK_OPTIONS, reviewCorrectionProcessor],
    [FACTORY_MERGE_QUEUE, FACTORY_FEATURE_MERGE_WORK_OPTIONS, featureMergeProcessor],
    [
      CHANGE_OVERVIEW_RENDER_QUEUE,
      CHANGE_OVERVIEW_RENDER_WORK_OPTIONS,
      {
        async process(data: unknown, signal: AbortSignal) {
          signal.throwIfAborted();
          const result = await changeOverviewRenderer.process(data);
          signal.throwIfAborted();
          log.info({ event: "change_overview.rendering_finished", result });
        },
      },
    ],
  ] as const;

  async function start(): Promise<void> {
    await boss.start();
    if (isStopped()) return;
    await reconcilePlanningTurns(pool);
    for (const repair of repairs) {
      if (isStopped()) return;
      await repair.run();
    }
    for (const [queue, options, processor] of queues) {
      if (isStopped()) return;
      await boss.work<unknown>(queue, options, async (jobs) => {
        const job = jobs[0];
        if (job === undefined) return;
        const signal =
          queue === CHANGE_OVERVIEW_RENDER_QUEUE
            ? job.signal
            : AbortSignal.any([job.signal, lifecycle.signal]);
        // A fetch already in flight can dispatch after stop. The domain processor must
        // claim and settle that delivery, including its interruption, before it is acknowledged.
        await processor.process(job.data, signal);
      });
      consumers.push(queue);
    }
    if (isStopped()) return;
    for (const repair of repairs) {
      let active: Promise<void> | null = null;
      const timer = setInterval(() => {
        if (active !== null || isStopped()) return;
        const running = Promise.resolve()
          .then(repair.run)
          .catch((error: unknown) => log.error({ err: error, event: repair.event }))
          .finally(() => {
            activeRepairs.delete(running);
            active = null;
          });
        active = running;
        activeRepairs.add(running);
      }, repair.interval);
      timer.unref();
      timers.push(timer);
    }
  }

  return {
    start(): Promise<void> {
      if (isStopped()) return Promise.reject(new Error("Factory background runtime is stopped"));
      if (starting === undefined) {
        boss.on("error", logQueueError);
        starting = start();
      }
      return starting;
    },
    stop(options: { graceful?: boolean } = {}): Promise<void> {
      if (stopping !== undefined) return stopping;
      lifecycle.abort(new Error("Factory background runtime is stopped"));
      for (const timer of timers) clearInterval(timer);
      // Abort writers immediately, including when startup or HTTP draining is still in flight.
      const processorsStopped = Promise.allSettled([
        executionProcessor.stop(),
        conceptualReviewProcessor.stop(),
        reviewCorrectionProcessor.stop(),
        featureMergeProcessor.stop(),
        featurePublicationProcessor.stop(),
      ]);
      stopping = (async () => {
        await starting?.catch(() => undefined);
        const drained = await Promise.allSettled([
          ...consumers.map((queue) => boss.offWork(queue)),
          ...activeRepairs,
        ]);
        const results = [...(await processorsStopped), ...drained];
        try {
          await boss.stop(options);
        } finally {
          boss.off("error", logQueueError);
        }
        const failures = results
          .filter((result) => result.status === "rejected")
          .map((result): unknown => result.reason);
        if (failures.length > 0)
          throw new AggregateError(failures, "Factory background shutdown failed");
      })();
      return stopping;
    },
  };
}
