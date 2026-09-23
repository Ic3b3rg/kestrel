import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { buildApp } from "./app.js";
import { createFactoryBackgroundRuntime } from "./factory-background-runtime.js";
import { createCodexAppServerAgentRuntime } from "./codex-app-server.js";
import { CERTIFIED_CODEX_REVIEW_VERSION } from "./codex-review-runtime.js";
import { createDatabaseFactoryConceptualReviewService } from "./routes/factory-conceptual-review.js";
import { createDatabaseExternalConceptualReviewService } from "./routes/external-conceptual-review.js";
import {
  createLocalRepositoryService,
  inspectLocalSourceAttachments,
} from "./routes/local-repository-sources.js";
import { createReviewRevisionService } from "./routes/review-revisions.js";
import { createDirectApiProfileService } from "./routes/direct-api-profiles.js";
import { createDatabaseProjectService, createHostGitHubProjectService } from "./routes/projects.js";
import { readSessionSigningKey } from "./session.js";

import {
  createPgBoss,
  createPool,
  readReferencedArtifactLocators,
  readDatabaseConfig,
  readEventRetentionLimit,
  openLocalProject,
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
const factoryConceptualReviewService = createDatabaseFactoryConceptualReviewService(
  pool,
  () => readLocalSourceConfig(),
  { boss, runtimeProfile: factoryConceptualReviewRuntimeProfile },
);
const externalConceptualReviewService = createDatabaseExternalConceptualReviewService(
  pool,
  () => readLocalSourceConfig(),
  { boss, runtimeProfile: factoryConceptualReviewRuntimeProfile },
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
  factoryConceptualReviewRuntimeProfile,
  factoryConceptualReviewService,
  externalConceptualReviewService,
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
const background = createFactoryBackgroundRuntime({
  pool,
  boss,
  log: app.log,
  localSourceConfig,
  readSourceConfig: () => readLocalSourceConfig(),
  credentialStore,
  transport: openAiTransport,
  conceptualReview: factoryConceptualReviewService,
  conceptualReviewRuntimeProfile: factoryConceptualReviewRuntimeProfile,
  ...(factoryExecutionImage === undefined ? {} : { containerImage: factoryExecutionImage }),
  ...(factoryDockerExecutable === undefined ? {} : { dockerExecutable: factoryDockerExecutable }),
});
let shuttingDown: Promise<void> | undefined;
function shutdown(signal: string, graceful = true): Promise<void> {
  if (shuttingDown !== undefined) return shuttingDown;
  app.log.info({ event: "web.stopping", signal });
  shuttingDown = (async () => {
    // Stop tools before waiting for HTTP clients; keep shared pools until both have drained.
    const results = await Promise.allSettled([background.stop({ graceful }), app.close()]);
    results.push(...(await Promise.allSettled([eventPool.end(), pool.end()])));
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result): unknown => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "Web shutdown failed");
    app.log.info({ event: "web.stopped", signal });
  })();
  return shuttingDown;
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
  await background.start();
  if (shuttingDown === undefined) {
    await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: readPort(process.env.PORT) });
    app.log.info({ event: "web.started" });
  }
} catch (error) {
  app.log.error({ err: error, event: "web.start_failed" });
  await shutdown("start_failed", false);
  process.exitCode = 1;
}
