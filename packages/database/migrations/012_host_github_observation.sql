ALTER TABLE projects
DROP CONSTRAINT projects_provider_identity_complete;

ALTER TABLE projects
ADD COLUMN provider_host_snapshot text,
ADD COLUMN provider_account_snapshot text,
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

GRANT SELECT, INSERT, UPDATE, DELETE
ON projects
TO kestrel_app;
