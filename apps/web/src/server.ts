import { isAbsolute, resolve } from "node:path";

import { buildApp } from "./app.js";
import {
  createLocalRepositoryService,
  inspectLocalSourceAttachments,
} from "./routes/local-repository-sources.js";
import { createReviewRevisionService } from "./routes/review-revisions.js";
import { createDirectApiProfileService } from "./routes/direct-api-profiles.js";
import { createDatabaseProjectService, createHostGitHubProjectService } from "./routes/projects.js";
import { readSessionSigningKey } from "./session.js";
import {
  CHANGE_OVERVIEW_RENDER_WORK_OPTIONS,
  createChangeOverviewRenderer,
  createDatabaseChangeOverviewRenderingPersistence,
} from "./change-overview-renderer.js";

import {
  createPgBoss,
  createPool,
  CHANGE_OVERVIEW_RENDER_QUEUE,
  readReferencedArtifactLocators,
  readDatabaseConfig,
  readEventRetentionLimit,
  reconcileAcquiringRevisions,
  reconcileLocalSourceAttachments,
  withArtifactLifecycleLock,
} from "@kestrel/database";
import { readLocalSourceConfig, reconcileArtifactRoot } from "@kestrel/local-source";
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
  projectService: createDatabaseProjectService(pool, boss),
  pwaRoot: process.env.PWA_ROOT ?? resolve(import.meta.dirname, "../../pwa/dist"),
  sessionSigningKey,
  reviewRevisionService: createReviewRevisionService(pool, localRepositoryService, boss),
});
const changeOverviewRenderer = createChangeOverviewRenderer({
  credentialStore,
  persistence: createDatabaseChangeOverviewRenderingPersistence(pool),
  transport: openAiTransport,
});
boss.on("error", (error) => {
  app.log.error({ err: error, event: "pgboss.error" });
});
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info({ event: "web.stopping", signal });
  await app.close();
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
  app.log.error({ err: error, event: "web.start_failed" });
  await app.close();
  await boss.stop({ graceful: false });
  await eventPool.end();
  await pool.end();
  process.exitCode = 1;
}
