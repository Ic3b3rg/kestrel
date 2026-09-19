-- One cumulative Feature PR operation consumes one immutable final certificate.
ALTER TABLE factory_feature_verifications ADD UNIQUE (id, feature_id, plan_version);

CREATE TABLE factory_feature_pr_publications (
  feature_id uuid PRIMARY KEY REFERENCES factory_features(id),
  plan_version integer NOT NULL,
  certificate_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'blocked', 'uncertain', 'published', 'cancelled')),
  job_id uuid NOT NULL DEFAULT uuidv7(),
  attempt_id uuid,
  started_at timestamptz,
  failure text,
  push_attempted boolean NOT NULL DEFAULT false,
  push_confirmed_at timestamptz,
  pr_attempted boolean NOT NULL DEFAULT false,
  retry_after timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (certificate_id, feature_id, plan_version)
    REFERENCES factory_feature_verifications(id, feature_id, plan_version),
  FOREIGN KEY (feature_id, plan_version) REFERENCES factory_plan_approvals(feature_id, plan_version)
);

-- Freeze source, target/account, exact refs/revision, ordered issue identities and PR
-- payload before the first external write. A retry cannot replace these inputs.
CREATE TABLE factory_feature_pr_operations (
  feature_id uuid PRIMARY KEY REFERENCES factory_feature_pr_publications(feature_id),
  id uuid NOT NULL UNIQUE DEFAULT uuidv7(),
  target jsonb NOT NULL,
  issues jsonb NOT NULL CHECK (jsonb_typeof(issues) = 'array' AND jsonb_array_length(issues) BETWEEN 1 AND 40),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE factory_feature_pr_results (
  feature_id uuid PRIMARY KEY REFERENCES factory_feature_pr_publications(feature_id),
  pull_request jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX factory_feature_pr_result_identity ON factory_feature_pr_results
  ((pull_request->'repository'->>'id'), (pull_request->>'id'));

CREATE TABLE factory_feature_pr_revisions (
  feature_id uuid PRIMARY KEY REFERENCES factory_feature_pr_results(feature_id),
  project_id uuid NOT NULL REFERENCES projects(id),
  change_proposal_id uuid NOT NULL REFERENCES change_proposals(id),
  review_revision_id uuid NOT NULL REFERENCES review_revisions(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE factory_feature_pr_retry_requests (
  feature_id uuid NOT NULL REFERENCES factory_feature_pr_publications(feature_id),
  request_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES operators(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (feature_id, request_id)
);

GRANT SELECT, INSERT ON factory_feature_pr_publications, factory_feature_pr_operations,
  factory_feature_pr_results, factory_feature_pr_revisions, factory_feature_pr_retry_requests TO kestrel_runtime;
REVOKE UPDATE, DELETE ON factory_feature_pr_publications, factory_feature_pr_operations,
  factory_feature_pr_results, factory_feature_pr_revisions, factory_feature_pr_retry_requests FROM kestrel_runtime;
GRANT UPDATE (state, job_id, attempt_id, started_at, failure, push_attempted,
  push_confirmed_at, pr_attempted, retry_after, updated_at) ON factory_feature_pr_publications TO kestrel_runtime;
