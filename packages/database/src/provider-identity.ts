import type { PoolClient } from "pg";

export async function lockGitHubRepositoryIdentity(
  client: PoolClient,
  repository: { name: string; owner: string },
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('kestrel-github-repository:' || lower($1) || '/' || lower($2), 0))",
    [repository.owner, repository.name],
  );
}
