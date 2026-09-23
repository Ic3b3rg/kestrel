import {
  ProjectBoardSnapshotSchema,
  ProjectBoardWorkItemSchema,
  type ProjectBoardSnapshot,
} from "@kestrel/contracts";
import {
  readProjectFactoryBoards,
  readProjectGitHubCoordinates,
  type DatabasePool,
} from "@kestrel/database";
import { FactoryGitHubError, type FactoryGitHubAdapter } from "./factory-github.js";

type Catalog = ProjectBoardSnapshot["github"];
const catalogLifetimeMs = 30_000;
const providerDeadlineMs = 10_000;
const maximumCachedProjects = 32;

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
  const catalogs = new Map<string, { value: Catalog; expiresAt: number; generation: number }>();
  let generation = 0;

  async function readCatalog(
    projectId: string,
    signal: AbortSignal,
    refresh: boolean,
  ): Promise<Catalog> {
    const coordinates = await readProjectGitHubCoordinates(pool, projectId);
    signal.throwIfAborted();
    const key = `${projectId}:${coordinates?.owner ?? ""}/${coordinates?.repository ?? ""}`;
    const previous = catalogs.get(key);
    if (!refresh && previous !== undefined && previous.expiresAt > Date.now())
      return previous.value;
    const controller = new AbortController();
    const providerSignal = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), providerDeadlineMs);
    const requestGeneration = ++generation;
    const load = () =>
      coordinates === null
        ? Promise.reject(new FactoryGitHubError("project_not_supported"))
        : github.readIssueCatalog(
            { owner: coordinates.owner, name: coordinates.repository },
            providerSignal,
          );
    let onAbort = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new FactoryGitHubError(signal.aborted ? "cancelled" : "timeout"));
      providerSignal.addEventListener("abort", onAbort, { once: true });
      if (providerSignal.aborted) onAbort();
    });
    let failure: Catalog["failure"];
    let observed: Awaited<ReturnType<FactoryGitHubAdapter["readIssueCatalog"]>> | undefined;
    try {
      observed = await Promise.race([load(), aborted]);
      failure = observed.failure;
    } catch (error) {
      if (signal.aborted) throw new FactoryGitHubError("cancelled");
      failure = controller.signal.aborted
        ? "timeout"
        : error instanceof FactoryGitHubError
          ? error.failure
          : "unavailable";
    } finally {
      clearTimeout(timer);
      providerSignal.removeEventListener("abort", onAbort);
    }
    const latest = catalogs.get(key);
    if (latest !== undefined && latest.generation > requestGeneration) return latest.value;
    const retained = failure !== null && latest !== undefined;
    const issues = observed?.issues ?? [];
    const value: Catalog = {
      issues: retained
        ? latest.value.issues
        : issues.map(({ repository, id, number, url, title, state }) => ({
            repository,
            id,
            number,
            url,
            title,
            state,
          })),
      checkedAt: new Date().toISOString(),
      fetchedAt: retained
        ? latest.value.fetchedAt
        : failure === null || issues.length > 0
          ? new Date().toISOString()
          : null,
      failure,
      retained,
      limited: retained
        ? latest.value.limited
        : (observed?.limited ?? false) || (failure !== null && issues.length > 0),
    };
    catalogs.delete(key);
    catalogs.set(key, {
      value,
      expiresAt: Date.now() + catalogLifetimeMs,
      generation: requestGeneration,
    });
    if (catalogs.size > maximumCachedProjects) {
      const oldest = catalogs.keys().next().value;
      if (oldest !== undefined) catalogs.delete(oldest);
    }
    return value;
  }

  return {
    async read(projectId, signal, refreshProvider = false) {
      signal.throwIfAborted();
      const local = await readProjectFactoryBoards(pool, projectId);
      const readAt = new Date().toISOString();
      const catalog = await readCatalog(local.projectId, signal, refreshProvider);
      signal.throwIfAborted();
      const approved = new Set(local.boards.map(({ feature }) => feature.id));
      const workItems = local.boards.flatMap((board) =>
        board.columns.flatMap((column) =>
          column.items.map((item) =>
            ProjectBoardWorkItemSchema.parse({
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
                column: item.column,
                blocking: item.blocking,
                providerUrl: item.providerUrl,
              },
            }),
          ),
        ),
      );
      const linked = new Set(workItems.map(({ item }) => item.providerUrl));
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
          (feature) => feature.state === "planning" && !approved.has(feature.id),
        ),
        workItems,
        github: { ...catalog, issues },
      });
    },
  };
}
