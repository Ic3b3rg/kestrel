import {
  ProjectBoardSnapshotSchema,
  ProjectBoardWorkItemSchema,
  type ProjectBoardSnapshot,
} from "@kestrel/contracts";
import {
  readProjectIssueObservation,
  saveProjectIssueObservation,
  readProjectBoardSettings,
  readProjectIssueStarts,
  readProjectFactoryBoards,
  readProjectGitHubCoordinates,
  type DatabasePool,
} from "@kestrel/database";
import { FactoryGitHubError, type FactoryGitHubAdapter } from "./factory-github.js";
import {
  readProjectGitHubThrottle,
  retainProjectGitHubThrottle,
} from "./project-github-throttle.js";

type Catalog = ProjectBoardSnapshot["github"];
const catalogLifetimeMs = 60_000;
const providerDeadlineMs = 10_000;

export interface ProjectBoardService {
  read(
    projectId: string,
    signal: AbortSignal,
    refreshProvider?: boolean,
  ): Promise<ProjectBoardSnapshot>;
}

export function createProjectBoardService(
  pool: DatabasePool,
  github: FactoryGitHubAdapter,
): ProjectBoardService {
  const pending = new Map<string, Promise<Catalog>>();

  async function readCatalog(
    projectId: string,
    signal: AbortSignal,
    refresh: boolean,
  ): Promise<Catalog> {
    const coordinates = await readProjectGitHubCoordinates(pool, projectId);
    signal.throwIfAborted();
    const key = `catalog:${coordinates?.owner ?? ""}/${coordinates?.repository ?? ""}`;
    const previousValue = await readProjectIssueObservation(pool, projectId, key);
    const parsed = ProjectBoardSnapshotSchema.shape.github.safeParse(previousValue);
    const previous = parsed.success ? parsed.data : null;
    const now = Date.now();
    const throttle = await readProjectGitHubThrottle(
      pool,
      projectId,
      `${coordinates?.owner ?? ""}/${coordinates?.repository ?? ""}`,
    );
    if (throttle !== null)
      return previous === null
        ? {
            issues: [],
            checkedAt: new Date().toISOString(),
            fetchedAt: null,
            failure: "rate_limited",
            limited: false,
            retained: false,
            retryAt: throttle,
          }
        : { ...previous, failure: "rate_limited", retained: true, retryAt: throttle };
    // Explicit refresh cannot bypass a provider's throttle deadline.
    if (
      previous !== null &&
      ((previous.retryAt != null && Date.parse(previous.retryAt) > now) ||
        (!refresh && Date.parse(previous.checkedAt) + catalogLifetimeMs > now))
    )
      return previous;
    const taskKey = `${projectId}:${key}`;
    let task = pending.get(taskKey);
    if (task === undefined) {
      task = refreshCatalog(projectId, key, coordinates, previous);
      pending.set(taskKey, task);
      void task.finally(() => pending.delete(taskKey)).catch(() => undefined);
    }
    if (previous !== null && !refresh) return { ...previous, refreshing: true };
    const waiting = task;
    return new Promise<Catalog>((resolve, reject) => {
      const abort = () => reject(new FactoryGitHubError("cancelled"));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      void waiting.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  async function refreshCatalog(
    projectId: string,
    key: string,
    coordinates: Awaited<ReturnType<typeof readProjectGitHubCoordinates>>,
    previous: Catalog | null,
  ): Promise<Catalog> {
    let observed: Awaited<ReturnType<FactoryGitHubAdapter["readIssueCatalog"]>> | undefined;
    let failure: Catalog["failure"];
    let retryAt: string | null;
    const controller = new AbortController();
    const signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), providerDeadlineMs);
    try {
      if (coordinates === null) throw new FactoryGitHubError("project_not_supported");
      observed = await Promise.race([
        github.readIssueCatalog({ owner: coordinates.owner, name: coordinates.repository }, signal),
        new Promise<never>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new FactoryGitHubError("timeout")), {
            once: true,
          }),
        ),
      ]);
      failure = observed.failure;
      retryAt = observed.retryAt ?? null;
    } catch (error) {
      failure = error instanceof FactoryGitHubError ? error.failure : "unavailable";
      retryAt = error instanceof FactoryGitHubError ? (error.retryAt ?? null) : null;
    }
    clearTimeout(timer);
    if (failure === "rate_limited")
      retryAt = await retainProjectGitHubThrottle(
        pool,
        projectId,
        `${coordinates?.owner ?? ""}/${coordinates?.repository ?? ""}`,
        retryAt,
      );
    const retained = failure !== null && previous !== null;
    const issues = observed?.issues ?? [];
    const value: Catalog = {
      issues: retained
        ? previous.issues
        : issues.map(({ repository, id, number, url, title, state, labels, commentCount }) => ({
            repository,
            id,
            number,
            url,
            title,
            state,
            labels,
            commentCount,
          })),
      checkedAt: new Date().toISOString(),
      fetchedAt: retained
        ? previous.fetchedAt
        : failure === null || issues.length > 0
          ? new Date().toISOString()
          : null,
      failure,
      retained,
      limited: retained ? previous.limited : (observed?.limited ?? false),
      retryAt,
    };
    await saveProjectIssueObservation(pool, projectId, key, value);
    return value;
  }

  return {
    async read(projectId, signal, refreshProvider = false) {
      signal.throwIfAborted();
      const local = await readProjectFactoryBoards(pool, projectId);
      const readAt = new Date().toISOString();
      const settings = await readProjectBoardSettings(pool, local.projectId);
      const starts = await readProjectIssueStarts(pool, local.projectId);
      const catalog = await readCatalog(local.projectId, signal, refreshProvider);
      signal.throwIfAborted();
      const approved = new Set(local.boards.map(({ feature }) => feature.id));
      const workItems = local.boards.flatMap((board) =>
        board.columns.flatMap((column) =>
          column.items.map((item) =>
            ProjectBoardWorkItemSchema.parse({
              queued:
                item.column === "todo" &&
                starts.some((start) => start.featureId === board.feature.id),
              feature: {
                id: board.feature.id,
                projectId: board.feature.projectId,
                title: board.feature.title,
              },
              item: {
                id: item.id,
                featureId: item.featureId,
                key: item.key,
                order: item.order,
                title: item.title,
                dependsOn: item.dependsOn,
                column:
                  item.column === "todo" &&
                  starts.some((start) => start.featureId === board.feature.id)
                    ? "in_progress"
                    : item.column,
                blocking: item.blocking,
                providerUrl: item.providerUrl,
              },
            }),
          ),
        ),
      );
      const linked = new Set([
        ...workItems.map(({ item }) => item.providerUrl),
        ...starts.map((start) => start.issueUrl),
      ]);
      const seen = new Set<string>();
      const issues = catalog.issues.filter((issue) => {
        const key = `${issue.repository.id}:${issue.id}`;
        if (issue.state !== "open" || linked.has(issue.url) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return ProjectBoardSnapshotSchema.parse({
        schemaVersion: 1,
        projectId: local.projectId,
        readAt,
        planningFeatures: local.features.filter(
          (feature) =>
            feature.state === "planning" &&
            !approved.has(feature.id) &&
            !starts.some((start) => start.featureId === feature.id),
        ),
        workItems,
        settings,
        starts,
        github: { ...catalog, issues },
      });
    },
  };
}
