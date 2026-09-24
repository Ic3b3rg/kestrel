import {
  readProjectIssueObservation,
  saveProjectIssueObservation,
  type DatabasePool,
} from "@kestrel/database";

const key = (repository: string) => `github-throttle:${repository.toLowerCase()}`;
export async function readProjectGitHubThrottle(
  pool: DatabasePool,
  projectId: string,
  repository: string,
): Promise<string | null> {
  const deadline = await readProjectIssueObservation(pool, projectId, key(repository));
  return typeof deadline === "string" && Date.parse(deadline) > Date.now() ? deadline : null;
}
export async function retainProjectGitHubThrottle(
  pool: DatabasePool,
  projectId: string,
  repository: string,
  retryAt?: string | null,
): Promise<string> {
  const previous = await readProjectGitHubThrottle(pool, projectId, repository);
  const deadline = new Date(
    Math.max(Date.now() + 60_000, Date.parse(previous ?? "") || 0, Date.parse(retryAt ?? "") || 0),
  ).toISOString();
  await saveProjectIssueObservation(pool, projectId, key(repository), deadline);
  return deadline;
}
