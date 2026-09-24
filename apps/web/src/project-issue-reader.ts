import { ProjectIssueDiscussionSchema, type ProjectIssueDiscussion } from "@kestrel/contracts";
import {
  boardProjectId,
  readProjectGitHubCoordinates,
  readProjectIssueObservation,
  saveProjectIssueObservation,
  type DatabasePool,
} from "@kestrel/database";
import { FactoryGitHubError, type FactoryGitHubAdapter } from "./factory-github.js";
import { readProjectGitHubThrottle, retainProjectGitHubThrottle } from "./project-github-throttle.js";

export function createProjectIssueReader(pool: DatabasePool, github: FactoryGitHubAdapter) {
  const pending = new Map<string, Promise<ProjectIssueDiscussion>>();
  return async (
    projectId: string,
    number: number,
    page = 1,
    fresh = false,
  ): Promise<ProjectIssueDiscussion> => {
    const id = await boardProjectId(pool, projectId);
    const coordinates = await readProjectGitHubCoordinates(pool, id);
    if (coordinates === null) throw new FactoryGitHubError("project_not_supported");
    const key = `discussion:${coordinates.owner}/${coordinates.repository}:${number}:${page}`;
    const parsed = ProjectIssueDiscussionSchema.safeParse(
      await readProjectIssueObservation(pool, id, key),
    );
    const previous = parsed.success ? parsed.data : null;
    const repository=`${coordinates.owner}/${coordinates.repository}`;
    const retryAt=await readProjectGitHubThrottle(pool,id,repository);
    if(retryAt!==null) {
      if(previous!==null&&!fresh)return {...previous,failure:"rate_limited"};
      throw new FactoryGitHubError("rate_limited",retryAt);
    }
    if (!fresh && previous !== null && Date.parse(previous.fetchedAt) + 60_000 > Date.now())
      return previous;
    const taskKey = `${id}:${key}`;
    let task = pending.get(taskKey);
    if (task === undefined) {
      task = (async () => {
        try {
          const signal = AbortSignal.timeout(30_000);
          const identity = await github.identify(
            { owner: coordinates.owner, name: coordinates.repository },
            signal,
          );
          const discussion = await github.readIssueDiscussion(identity, number, page, signal);
          const value = ProjectIssueDiscussionSchema.parse({
            ...discussion,
            fetchedAt: new Date().toISOString(),
            failure: null,
          });
          await saveProjectIssueObservation(pool, id, key, value);
          return value;
        } catch (error) {
          if(error instanceof FactoryGitHubError && error.failure==="rate_limited")
            await retainProjectGitHubThrottle(pool,id,repository,error.retryAt);
          if (previous === null || fresh) throw error;
          const value:ProjectIssueDiscussion = {
            ...previous,
            failure: error instanceof FactoryGitHubError ? error.failure : "unavailable",
          };
          await saveProjectIssueObservation(pool,id,key,value);
          return value;
        }
      })();
      pending.set(taskKey, task);
      void task.finally(() => pending.delete(taskKey)).catch(() => undefined);
    }
    if (!fresh && previous !== null) return previous;
    return task;
  };
}
