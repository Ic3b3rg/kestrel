CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  provider_observation_kind text NOT NULL CHECK (provider_observation_kind = 'public_github'),
  provider text NOT NULL CHECK (provider = 'github'),
  provider_repository_id text NOT NULL CHECK (
    char_length(provider_repository_id) BETWEEN 1 AND 256
  ),
  repository_owner_snapshot text NOT NULL CHECK (
    char_length(repository_owner_snapshot) BETWEEN 1 AND 39
  ),
  repository_name_snapshot text NOT NULL CHECK (
    char_length(repository_name_snapshot) BETWEEN 1 AND 100
  ),
  repository_canonical_url_snapshot text NOT NULL CHECK (
    char_length(repository_canonical_url_snapshot) BETWEEN 1 AND 240
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (installation_id, provider, provider_repository_id)
);

CREATE TABLE change_proposals (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider_proposal_id text NOT NULL CHECK (
    char_length(provider_proposal_id) BETWEEN 1 AND 256
  ),
  provider_number bigint NOT NULL CHECK (provider_number BETWEEN 1 AND 9999999999),
  title_snapshot text NOT NULL CHECK (char_length(title_snapshot) BETWEEN 1 AND 512),
  canonical_url_snapshot text NOT NULL CHECK (
    char_length(canonical_url_snapshot) BETWEEN 1 AND 256
  ),
  proposal_state text NOT NULL CHECK (
    proposal_state IN ('open', 'merged', 'closed', 'unknown')
  ),
  base_ref_snapshot text NOT NULL CHECK (char_length(base_ref_snapshot) BETWEEN 1 AND 255),
  base_object_id text NOT NULL CHECK (base_object_id ~ '^[a-f0-9]{40}$'),
  head_ref_snapshot text NOT NULL CHECK (char_length(head_ref_snapshot) BETWEEN 1 AND 255),
  head_object_id text NOT NULL CHECK (head_object_id ~ '^[a-f0-9]{40}$'),
  author_provider_id text CHECK (
    author_provider_id IS NULL OR char_length(author_provider_id) BETWEEN 1 AND 256
  ),
  author_login_snapshot text CHECK (
    author_login_snapshot IS NULL OR char_length(author_login_snapshot) BETWEEN 1 AND 100
  ),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((author_provider_id IS NULL) = (author_login_snapshot IS NULL)),
  UNIQUE (project_id, provider_proposal_id),
  UNIQUE (project_id, provider_number)
);

CREATE INDEX change_proposals_project_observed_idx
ON change_proposals (project_id, observed_at DESC, id);

COMMENT ON TABLE projects IS
'One repository observed through bounded provider metadata kept separate from source access.';

COMMENT ON TABLE change_proposals IS
'Mutable provider observation kept separate from future immutable Review Revisions.';
