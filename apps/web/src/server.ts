import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { buildApp } from "./app.js";
import { createCodexAppServerAgentRuntime } from "./codex-app-server.js";
import { createCodexExecutionContainerRecovery } from "./codex-execution-runtime.js";
import { CERTIFIED_CODEX_REVIEW_VERSION } from "./codex-review-runtime.js";
import {
  createFactoryExecutionProcessor,
  FACTORY_EXECUTION_WORK_OPTIONS,
} from "./factory-execution-processor.js";
import {
  createFactoryConceptualReviewProcessor,
  FACTORY_CONCEPTUAL_REVIEW_WORK_OPTIONS,
} from "./conceptual-review-processor.js";
import {
  createLocalRepositoryService,
  inspectLocalSourceAttachments,
} from "./routes/local-repository-sources.js";
import { createReviewRevisionService } from "./routes/review-revisions.js";
import { createDirectApiProfileService } from "./routes/direct-api-profiles.js";
import { createDatabaseProjectService, createHostGitHubProjectService } from "./routes/projects.js";
import { readSessionSigningKey } from "./session.js";
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
  createPgBoss,
  createPool,
  CHANGE_OVERVIEW_RENDER_QUEUE,
  FACTORY_PLANNING_QUEUE,
  FACTORY_PUBLICATION_QUEUE,
  FACTORY_FEATURE_PUBLICATION_QUEUE,
  FACTORY_EXECUTION_QUEUE,
  FACTORY_CONCEPTUAL_REVIEW_QUEUE,
  readReferencedArtifactLocators,
  readDatabaseConfig,
  readEventRetentionLimit,
  openLocalProject,
  reconcileAcquiringRevisions,
  reconcileLocalSourceAttachments,
  reconcilePlanningTurns,
  reconcileFactoryPublications,
  reconcileFactoryFeaturePublications,
  reconcileFactoryExecutions,
  reconcileFactoryConceptualReviewWorkflows,
  withArtifactLifecycleLock,
} from "@kestrel/database";
import {
  disposeConceptualReviewAttemptResources,
  readLocalSourceConfig,
  reconcileArtifactRoot,
} from "@kestrel/local-source";
import { createOpenAiTransport, FileCredentialStore } from "@kestrel/model-provider";

function readPort(value: string | undefined): number {
  const port = Number(value ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function readModelProviderSecretRoot(value: string | undefined): string {
  if (value === undefined || !isAbsolute(value)) {
    throw new Error("MODEL_PROVIDER_SECRET_ROOT must be an absolute path");
  }
  return value;
}

const config = readDatabaseConfig();
const localSourceConfig = await readLocalSourceConfig();
const sessionSigningKey = readSessionSigningKey();
const modelProviderSecretRoot = readModelProviderSecretRoot(process.env.MODEL_PROVIDER_SECRET_ROOT);
const credentialStore = new FileCredentialStore(modelProviderSecretRoot);
await credentialStore.reconcile();
const openAiTransport = createOpenAiTransport();
const pool = createPool(config.databaseUrl, "kestrel-web");
const eventPool = createPool(config.databaseUrl, "kestrel-web-events", {
  connectionTimeoutMillis: 2_000,
  max: 10,
});
const boss = createPgBoss({
  applicationName: "kestrel-web-pgboss",
  databaseUrl: config.databaseUrl,
});
const localRepositoryService = createLocalRepositoryService(
  localSourceConfig,
  pool,
  process.env.LOCAL_REPOSITORY_ROOTS_FILE === undefined ? undefined : () => readLocalSourceConfig(),
);
const factoryExecutionImage = process.env.KESTREL_FACTORY_EXECUTION_IMAGE;
const factoryDockerExecutable = process.env.KESTREL_FACTORY_DOCKER_EXECUTABLE;
const configuredCodexExecutable = process.env.KESTREL_CODEX_EXECUTABLE;
const codexExecutable =
  configuredCodexExecutable !== undefined && isAbsolute(configuredCodexExecutable)
    ? await realpath(configuredCodexExecutable).catch(() => null)
    : null;
const codexAgentRuntime = createCodexAppServerAgentRuntime({
  ...(codexExecutable === null ? {} : { executable: codexExecutable }),
});
const codexConnection =
  codexExecutable === null ? null : await codexAgentRuntime.readConnection().catch(() => null);
const codexExecutableDigest =
  codexExecutable === null
    ? null
    : await readFile(codexExecutable)
        .then((bytes) => createHash("sha256").update(bytes).digest("hex"))
        .catch(() => null);
const runtimeUid = process.getuid?.() ?? 1000;
const runtimeGid = process.getgid?.() ?? 1000;
const factoryConceptualReviewRuntimeProfile =
  factoryExecutionImage?.trim() &&
  /^sha256:[a-f0-9]{64}$/u.test(factoryExecutionImage) &&
  runtimeUid > 0 &&
  runtimeGid > 0 &&
  codexExecutable !== null &&
  codexExecutableDigest !== null &&
  codexConnection?.cli?.supported === true &&
  codexConnection.cli.version === CERTIFIED_CODEX_REVIEW_VERSION
    ? {
        containerImage: factoryExecutionImage,
        containerUser: `${String(runtimeUid)}:${String(runtimeGid)}`,
        codexExecutable,
        codexExecutableDigest,
        codexVersion: codexConnection.cli.version,
      }
    : null;
await withArtifactLifecycleLock(pool, async (lockedPool) => {
  await reconcileAcquiringRevisions(lockedPool);
  const referenced = await readReferencedArtifactLocators(lockedPool);
  await reconcileArtifactRoot(localSourceConfig, referenced);
  await reconcileLocalSourceAttachments(
    lockedPool,
    await inspectLocalSourceAttachments(localSourceConfig),
  );
});
const app = await buildApp({
  boss,
  factoryConceptualReviewRuntimeProfile,
  codexAgentRuntime,
  eventPool,
  eventRetentionLimit: readEventRetentionLimit(),
  directApiProfileService: createDirectApiProfileService(
    pool,
    credentialStore,
    openAiTransport,
    sessionSigningKey,
  ),
  localRepositoryService,
  hostGitHubProjectService: createHostGitHubProjectService(pool, boss),
  pool,
  projectService: createDatabaseProjectService(pool, boss, async (command, context) =>
    openLocalProject(pool, {
      ...context,
      source: await localRepositoryService.inspectProjectSource(command.repositoryId),
    }),
  ),
  pwaRoot: process.env.PWA_ROOT ?? resolve(import.meta.dirname, "../../pwa/dist"),
  sessionSigningKey,
  reviewRevisionService: createReviewRevisionService(pool, localRepositoryService, boss),
});
const changeOverviewRenderer = createChangeOverviewRenderer({
  credentialStore,
  persistence: createDatabaseChangeOverviewRenderingPersistence(pool),
  transport: openAiTransport,
});
const planningProcessor = createFactoryPlanningProcessor({
  pool,
  readSourceConfig: () => readLocalSourceConfig(),
});
const publicationProcessor = createFactoryPublicationProcessor({ pool });
const featurePublicationProcessor = createFactoryFeaturePublicationProcessor({
  pool,
  readSourceConfig: () => readLocalSourceConfig(),
  retain: createFactoryFeatureRevisionRetainer({
    pool,
    readSourceConfig: () => readLocalSourceConfig(),
    renderingCoordinator: boss,
  }),
});
const recoverExecutionContainer = createCodexExecutionContainerRecovery(
  factoryDockerExecutable === undefined ? {} : { dockerExecutable: factoryDockerExecutable },
);
const executionProcessor = createFactoryExecutionProcessor({
  pool,
  readSourceConfig: () => readLocalSourceConfig(),
  ...(factoryExecutionImage === undefined ? {} : { containerImage: factoryExecutionImage }),
  ...(factoryDockerExecutable === undefined ? {} : { dockerExecutable: factoryDockerExecutable }),
});
const conceptualReviewProcessor = createFactoryConceptualReviewProcessor({
  pool,
  boss,
  readSourceConfig: () => readLocalSourceConfig(),
  ...(factoryExecutionImage === undefined ? {} : { containerImage: factoryExecutionImage }),
  ...(factoryDockerExecutable === undefined ? {} : { dockerExecutable: factoryDockerExecutable }),
  ...(factoryConceptualReviewRuntimeProfile === null
    ? {}
    : {
        codexExecutable: factoryConceptualReviewRuntimeProfile.codexExecutable,
        codexExecutableDigest: factoryConceptualReviewRuntimeProfile.codexExecutableDigest,
        codexVersion: factoryConceptualReviewRuntimeProfile.codexVersion,
        containerUser: factoryConceptualReviewRuntimeProfile.containerUser,
      }),
});
let publicationReconciliation: NodeJS.Timeout | undefined;
let featurePublicationReconciliation: NodeJS.Timeout | undefined;
let reconcilingFeaturePublication: Promise<void> | null = null;
let executionReconciliation: NodeJS.Timeout | undefined;
let reconcilingExecution: Promise<void> | null = null;
let conceptualReviewReconciliation: NodeJS.Timeout | undefined;
let reconcilingConceptualReview: Promise<void> | null = null;
boss.on("error", (error) => {
  app.log.error({ err: error, event: "pgboss.error" });
});
let shuttingDown = false;

async function stopExecutionAndHttp(): Promise<void> {
  // Interrupt tool execution before HTTP draining can wait on an open client.
  const stoppingExecution = executionProcessor.stop();
  const stoppingConceptualReview = conceptualReviewProcessor.stop();
  const stoppingPublication = featurePublicationProcessor.stop();
  await Promise.all([
    stoppingExecution,
    stoppingConceptualReview,
    stoppingPublication,
    app.close(),
  ]);
  await reconcilingExecution;
  await reconcilingConceptualReview;
  await reconcilingFeaturePublication;
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearInterval(publicationReconciliation);
  clearInterval(featurePublicationReconciliation);
  clearInterval(executionReconciliation);
  clearInterval(conceptualReviewReconciliation);
  app.log.info({ event: "web.stopping", signal });
  await stopExecutionAndHttp();
  await boss.stop();
  await eventPool.end();
  await pool.end();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error: unknown) => {
      app.log.error({ err: error, event: "web.stop_failed", signal });
      process.exitCode = 1;
    });
  });
}

try {
  await boss.start();
  await reconcilePlanningTurns(pool);
  await reconcileFactoryPublications(pool, boss);
  await reconcileFactoryExecutions(pool, boss, recoverExecutionContainer);
  await reconcileFactoryConceptualReviewWorkflows(
    pool,
    boss,
    recoverExecutionContainer,
    (attemptId) => disposeConceptualReviewAttemptResources(localSourceConfig, attemptId),
  );
  await reconcileFactoryFeaturePublications(pool, boss);
  featurePublicationReconciliation = setInterval(() => {
    if (reconcilingFeaturePublication !== null || shuttingDown) return;
    reconcilingFeaturePublication = reconcileFactoryFeaturePublications(pool, boss)
      .catch((error: unknown) =>
        app.log.error({ err: error, event: "factory.feature_publication_reconciliation_failed" }),
      )
      .finally(() => {
        reconcilingFeaturePublication = null;
      });
  }, 5_000);
  featurePublicationReconciliation.unref();
  executionReconciliation = setInterval(() => {
    if (reconcilingExecution !== null || shuttingDown) return;
    reconcilingExecution = reconcileFactoryExecutions(pool, boss, recoverExecutionContainer)
      .catch((error: unknown) =>
        app.log.error({ err: error, event: "factory.execution_reconciliation_failed" }),
      )
      .finally(() => {
        reconcilingExecution = null;
      });
  }, 2_000);
  executionReconciliation.unref();
  conceptualReviewReconciliation = setInterval(() => {
    if (reconcilingConceptualReview !== null || shuttingDown) return;
    reconcilingConceptualReview = reconcileFactoryConceptualReviewWorkflows(
      pool,
      boss,
      recoverExecutionContainer,
      (attemptId) => disposeConceptualReviewAttemptResources(localSourceConfig, attemptId),
    )
      .catch((error: unknown) =>
        app.log.error({ err: error, event: "factory.conceptual_review_reconciliation_failed" }),
      )
      .finally(() => {
        reconcilingConceptualReview = null;
      });
  }, 2_000);
  conceptualReviewReconciliation.unref();
  let reconcilingPublication = false;
  publicationReconciliation = setInterval(() => {
    if (reconcilingPublication || shuttingDown) return;
    reconcilingPublication = true;
    void reconcileFactoryPublications(pool, boss)
      .catch((error: unknown) =>
        app.log.error({ err: error, event: "factory.publication_reconciliation_failed" }),
      )
      .finally(() => {
        reconcilingPublication = false;
      });
  }, 5_000);
  publicationReconciliation.unref();
  await boss.work<unknown>(
    FACTORY_PUBLICATION_QUEUE,
    FACTORY_PUBLICATION_WORK_OPTIONS,
    async (jobs) => {
      const job = jobs[0];
      if (job !== undefined) await publicationProcessor.process(job.data, job.signal);
    },
  );
  await boss.work<unknown>(FACTORY_PLANNING_QUEUE, FACTORY_PLANNING_WORK_OPTIONS, async (jobs) => {
    const job = jobs[0];
    if (job !== undefined) await planningProcessor.process(job.data, job.signal);
  });
  await boss.work<unknown>(
    FACTORY_FEATURE_PUBLICATION_QUEUE,
    FACTORY_FEATURE_PUBLICATION_WORK_OPTIONS,
    async (jobs) => {
      const job = jobs[0];
      if (job !== undefined) await featurePublicationProcessor.process(job.data, job.signal);
    },
  );
  await boss.work<unknown>(
    FACTORY_EXECUTION_QUEUE,
    FACTORY_EXECUTION_WORK_OPTIONS,
    async (jobs) => {
      const job = jobs[0];
      if (job !== undefined) await executionProcessor.process(job.data, job.signal);
    },
  );
  await boss.work<unknown>(
    FACTORY_CONCEPTUAL_REVIEW_QUEUE,
    FACTORY_CONCEPTUAL_REVIEW_WORK_OPTIONS,
    async (jobs) => {
      const job = jobs[0];
      if (job !== undefined) await conceptualReviewProcessor.process(job.data, job.signal);
    },
  );
  await boss.work<unknown>(
    CHANGE_OVERVIEW_RENDER_QUEUE,
    CHANGE_OVERVIEW_RENDER_WORK_OPTIONS,
    async (jobs) => {
      const job = jobs[0];
      if (job === undefined) return;
      job.signal.throwIfAborted();
      const result = await changeOverviewRenderer.process(job.data);
      job.signal.throwIfAborted();
      app.log.info({ event: "change_overview.rendering_finished", result });
    },
  );
  await app.listen({
    host: process.env.HOST ?? "0.0.0.0",
    port: readPort(process.env.PORT),
  });
  app.log.info({ event: "web.started" });
} catch (error) {
  clearInterval(publicationReconciliation);
  clearInterval(featurePublicationReconciliation);
  clearInterval(executionReconciliation);
  clearInterval(conceptualReviewReconciliation);
  app.log.error({ err: error, event: "web.start_failed" });
  await stopExecutionAndHttp();
  await boss.stop({ graceful: false });
  await eventPool.end();
  await pool.end();
  process.exitCode = 1;
}
