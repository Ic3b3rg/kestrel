import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { KestrelIdSchema, type FactoryGitHubIssue } from "@kestrel/contracts";
import {
  FactoryError,
  claimFactoryPublication,
  setFactoryPublicationIdentity,
  prepareFactoryProviderOperation,
  markFactoryProviderAttempt,
  bindFactoryPublishedIssue,
  bindFactoryPublishedComment,
  readFactoryProviderDependencies,
  setFactoryProviderDependency,
  completeFactoryPublicationItem,
  failFactoryPublication,
  isFactoryPublicationRunning,
  type ClaimedFactoryPublication,
  type DatabasePool,
} from "@kestrel/database";
import {
  createFactoryGitHubAdapter,
  FactoryGitHubError,
  type FactoryGitHubAdapter,
  type FactoryGitHubIdentity,
  type WriteResult,
  type Reconciliation,
} from "./factory-github.js";
import { factoryProviderMarker, renderFactoryIssueContent } from "./factory-issue-content.js";

export const FACTORY_PUBLICATION_WORK_OPTIONS = {
  batchSize: 1,
  localConcurrency: 2,
  pollingIntervalSeconds: 1,
  notifyPollingIntervalSeconds: 5,
} as const;
const issuePayload = z.strictObject({
  title: z.string().min(1).max(256),
  body: z.string().min(1).max(65_000),
});
const commentPayload = z.strictObject({ body: z.string().min(1).max(65_000) });

function requireMatch<T>(result: Reconciliation<T>): T {
  if (result.state === "found") return result.value;
  throw new FactoryGitHubError(
    result.state === "limited" ? "reconciliation_limit" : "uncertain_write",
  );
}

export function createFactoryPublicationProcessor({
  pool,
  github = createFactoryGitHubAdapter(),
}: {
  pool: DatabasePool;
  github?: FactoryGitHubAdapter;
}) {
  // Serialize writes from both Project workers; GitHub recommends >=1 second between mutations.
  let writes: Promise<void> = Promise.resolve();
  let lastWrite = 0;
  async function write<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const previous = writes;
    let release: (() => void) | undefined;
    writes = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      signal.throwIfAborted();
      const remaining = 1_000 - (Date.now() - lastWrite);
      if (remaining > 0) await delay(remaining, undefined, { signal });
      signal.throwIfAborted();
      lastWrite = Date.now();
      return await action();
    } finally {
      release?.();
    }
  }

  async function created<T>(
    claim: ClaimedFactoryPublication,
    kind: "issue" | "comment",
    result: WriteResult<T>,
  ): Promise<T> {
    if (result.state === "confirmed") return result.value;
    if (result.state !== "uncertain") await markFactoryProviderAttempt(pool, claim, kind, false);
    throw new FactoryGitHubError(
      result.state === "uncertain" ? "uncertain_write" : result.failure,
      result.retryAt,
    );
  }

  function content(claim: ClaimedFactoryPublication, marker: string): string {
    const definition = claim.plan.workItems.find(({ key }) => key === claim.item.key);
    if (definition === undefined) throw new FactoryError("invalid_plan");
    const dependencies = definition.dependsOn.map((key) => {
      const linked = claim.items.find((item) => item.key === key)?.issue;
      if (linked === undefined || linked === null)
        throw new FactoryError("conflict", "Publish dependencies before their dependent Work Item");
      return { key, url: linked.url };
    });
    return renderFactoryIssueContent({
      title: claim.title,
      version: claim.version,
      plan: claim.plan,
      itemKey: claim.item.key,
      featureUrl: claim.featureUrl,
      marker,
      dependencies,
    });
  }

  async function publishIssue(
    claim: ClaimedFactoryPublication,
    identity: FactoryGitHubIdentity,
    signal: AbortSignal,
  ): Promise<FactoryGitHubIssue> {
    if (claim.item.issue !== null) {
      const current = await github.readIssue(identity, claim.item.issue.number, signal);
      if (current.id !== claim.item.issue.id) throw new FactoryGitHubError("repository_changed");
      // Provider edits are not copied into the frozen plan or imported snapshot.
      return claim.item.issue;
    }
    const marker = factoryProviderMarker(claim.item.issue_operation_id);
    const definition = claim.plan.workItems.find(({ key }) => key === claim.item.key);
    const payload = issuePayload.parse(
      await prepareFactoryProviderOperation(pool, claim, "issue", {
        title: `${claim.item.key}: ${definition?.title ?? claim.title}`,
        body: content(claim, marker),
      }),
    );
    const issue = claim.item.issue_attempted
      ? requireMatch(await github.findIssue(identity, marker, signal))
      : await write(signal, async () => {
          await markFactoryProviderAttempt(pool, claim, "issue", true);
          return created(claim, "issue", await github.createIssue(identity, payload, signal));
        });
    await bindFactoryPublishedIssue(pool, claim, issue);
    return issue;
  }

  async function dependencies(
    claim: ClaimedFactoryPublication,
    identity: FactoryGitHubIdentity,
    issue: FactoryGitHubIssue,
    signal: AbortSignal,
  ) {
    const edges = await readFactoryProviderDependencies(pool, claim);
    for (const edge of edges) {
      if (["confirmed", "textual"].includes(edge.state)) continue;
      const blocker = claim.items.find(
        (item) => item.work_item_id === edge.blocking_work_item_id,
      )?.issue;
      if (blocker === undefined || blocker === null) throw new FactoryError("conflict");
      const current = await github.readDependencies(identity, issue.number, signal);
      if (current.state === "unsupported") {
        await setFactoryProviderDependency(pool, claim, edge.blocking_work_item_id, "textual");
        continue;
      }
      if (current.dependencies.some(({ id }) => id === blocker.id)) {
        await setFactoryProviderDependency(pool, claim, edge.blocking_work_item_id, "confirmed");
        continue;
      }
      if (edge.state === "attempted") throw new FactoryGitHubError("uncertain_write");
      const result = await write(signal, async () => {
        await setFactoryProviderDependency(pool, claim, edge.blocking_work_item_id, "attempted");
        return github.addDependency(identity, issue.number, blocker.id, signal);
      });
      if (result.state === "unsupported" || result.state === "confirmed") {
        await setFactoryProviderDependency(
          pool,
          claim,
          edge.blocking_work_item_id,
          result.state === "unsupported" ? "textual" : "confirmed",
        );
      } else {
        if (result.state !== "uncertain")
          await setFactoryProviderDependency(pool, claim, edge.blocking_work_item_id, "pending");
        throw new FactoryGitHubError(
          result.state === "uncertain" ? "uncertain_write" : result.failure,
          result.retryAt,
        );
      }
    }
  }

  async function publishComment(
    claim: ClaimedFactoryPublication,
    identity: FactoryGitHubIdentity,
    issue: FactoryGitHubIssue,
    signal: AbortSignal,
  ) {
    if (claim.item.comment_id !== null) return;
    const marker = factoryProviderMarker(claim.item.comment_operation_id);
    const payload = commentPayload.parse(
      await prepareFactoryProviderOperation(pool, claim, "comment", {
        body: content(claim, marker),
      }),
    );
    const comment = claim.item.comment_attempted
      ? requireMatch(await github.findComment(identity, issue.number, marker, signal))
      : await write(signal, async () => {
          await markFactoryProviderAttempt(pool, claim, "comment", true);
          return created(
            claim,
            "comment",
            await github.createComment(identity, issue.number, payload.body, signal),
          );
        });
    await bindFactoryPublishedComment(pool, claim, comment.id);
  }

  return {
    async process(data: unknown, jobSignal?: AbortSignal): Promise<void> {
      const { featureId } = z.strictObject({ featureId: KestrelIdSchema }).parse(data);
      const claim = await claimFactoryPublication(pool, featureId);
      if (claim === null) return;
      const controller = new AbortController();
      const deadline = AbortSignal.timeout(175_000);
      const signal = AbortSignal.any([
        controller.signal,
        deadline,
        ...(jobSignal === undefined ? [] : [jobSignal]),
      ]);
      let polling = false;
      const cancellation = setInterval(() => {
        if (polling) return;
        polling = true;
        void isFactoryPublicationRunning(pool, claim)
          .then((running) => {
            if (!running) controller.abort();
          })
          .catch(() => controller.abort())
          .finally(() => {
            polling = false;
          });
      }, 1_000);
      cancellation.unref();
      try {
        if (claim.coordinates === null) throw new FactoryGitHubError("project_not_supported");
        const identity = await github.identify(claim.coordinates, signal);
        if (
          claim.identity !== null &&
          (identity.repository.id !== claim.identity.repository.id ||
            identity.account.toLowerCase() !== claim.identity.account.toLowerCase())
        )
          throw new FactoryGitHubError("repository_changed");
        await setFactoryPublicationIdentity(pool, claim, identity);
        const issue = await publishIssue(claim, identity, signal);
        await dependencies(claim, identity, issue, signal);
        await publishComment(claim, identity, issue, signal);
        signal.throwIfAborted();
        await completeFactoryPublicationItem(pool, claim);
      } catch (error) {
        const failure =
          error instanceof FactoryGitHubError
            ? error.failure
            : deadline.aborted
              ? "timeout"
              : signal.aborted
                ? "cancelled"
                : error instanceof FactoryError && error.code === "conflict"
                  ? "issue_already_bound"
                  : "invalid_response";
        try {
          await failFactoryPublication(
            pool,
            claim,
            failure,
            error instanceof FactoryGitHubError ? error.retryAt : undefined,
          );
        } catch (stale) {
          if (!(stale instanceof FactoryError) || stale.code !== "conflict") throw stale;
        }
      } finally {
        clearInterval(cancellation);
      }
    },
  };
}
