ALTER TABLE projects
DROP CONSTRAINT projects_provider_identity_complete,
DROP CONSTRAINT projects_provider_observation_kind_check;

ALTER TABLE projects
ADD COLUMN provider_host_snapshot text CHECK (
  provider_host_snapshot IS NULL OR char_length(provider_host_snapshot) BETWEEN 1 AND 253
),
ADD COLUMN provider_account_snapshot text CHECK (
  provider_account_snapshot IS NULL OR char_length(provider_account_snapshot) BETWEEN 1 AND 100
),
ADD CONSTRAINT projects_provider_observation_kind_check CHECK (
  provider_observation_kind IS NULL OR provider_observation_kind IN ('public_github', 'host_gh')
),
ADD CONSTRAINT projects_provider_identity_complete CHECK (
  (
    provider_observation_kind IS NULL
    AND provider IS NULL
    AND provider_repository_id IS NULL
    AND repository_owner_snapshot IS NULL
    AND repository_name_snapshot IS NULL
    AND repository_canonical_url_snapshot IS NULL
    AND provider_host_snapshot IS NULL
    AND provider_account_snapshot IS NULL
  ) OR (
    provider_observation_kind = 'public_github'
    AND provider = 'github'
    AND provider_repository_id IS NOT NULL
    AND repository_owner_snapshot IS NOT NULL
    AND repository_name_snapshot IS NOT NULL
    AND repository_canonical_url_snapshot IS NOT NULL
    AND provider_host_snapshot IS NULL
    AND provider_account_snapshot IS NULL
  ) OR (
    provider_observation_kind = 'host_gh'
    AND provider = 'github'
    AND provider_repository_id IS NOT NULL
    AND repository_owner_snapshot IS NOT NULL
    AND repository_name_snapshot IS NOT NULL
    AND repository_canonical_url_snapshot IS NOT NULL
    AND provider_host_snapshot IS NOT NULL
    AND provider_account_snapshot IS NOT NULL
  )
);

ALTER TABLE change_proposals
ADD COLUMN body_snapshot text CHECK (body_snapshot IS NULL OR octet_length(body_snapshot) <= 65536);
