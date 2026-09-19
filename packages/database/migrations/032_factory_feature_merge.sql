-- One explicit Operator approval merges exactly one complete Conceptual Review revision.
ALTER TABLE factory_features DROP CONSTRAINT factory_features_state_check;
ALTER TABLE factory_features ADD CONSTRAINT factory_features_state_check
  CHECK (state IN ('planning', 'queued', 'implementing', 'gated', 'in_review', 'merging', 'completed', 'cancelled'));

CREATE TABLE factory_feature_merges (
  feature_id uuid PRIMARY KEY REFERENCES factory_features(id) ON DELETE RESTRICT,
  id uuid NOT NULL UNIQUE DEFAULT uuidv7(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  plan_version integer NOT NULL,
  requested_by_operator_id uuid NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  source_workflow_id uuid NOT NULL REFERENCES review_workflows(id) ON DELETE RESTRICT,
  source_artifact_id uuid NOT NULL REFERENCES factory_conceptual_review_artifacts(id) ON DELETE RESTRICT,
  source_review_revision_id uuid NOT NULL REFERENCES review_revisions(id) ON DELETE RESTRICT,
  source_input_digest text NOT NULL CHECK (source_input_digest ~ '^[a-f0-9]{64}$'),
  base_commit_id text NOT NULL CHECK (base_commit_id ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'),
  head_commit_id text NOT NULL CHECK (head_commit_id ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'),
  certificate_id uuid NOT NULL REFERENCES factory_feature_verifications(id) ON DELETE RESTRICT,
  publication_operation_id uuid NOT NULL REFERENCES factory_feature_pr_operations(id) ON DELETE RESTRICT,
  identity jsonb NOT NULL CHECK (jsonb_typeof(identity) = 'object'),
  pull_request jsonb NOT NULL CHECK (jsonb_typeof(pull_request) = 'object'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued', 'checking', 'merging', 'uncertain', 'closing_issues', 'blocked', 'completed'
  )),
  failure text CHECK (failure IN (
    'review_required', 'review_outdated', 'review_partial', 'certificate_stale',
    'active_correction', 'pull_request_changed', 'pull_request_closed',
    'checks_pending', 'checks_failed', 'merge_conflict', 'uncertain_write',
    'issue_closure_failed', 'needs_authentication', 'access_denied', 'rate_limited',
    'invalid_response', 'unavailable', 'timeout', 'retry_limit'
  )),
  job_id uuid NOT NULL DEFAULT uuidv7(),
  attempt_id uuid,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  merge_attempted boolean NOT NULL DEFAULT false,
  merge_commit_id text CHECK (merge_commit_id IS NULL OR merge_commit_id ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'),
  provider_merged_at timestamptz,
  retry_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (feature_id, request_id),
  UNIQUE (id, feature_id),
  FOREIGN KEY (feature_id, plan_version) REFERENCES factory_plan_approvals(feature_id, plan_version),
  CHECK ((merge_commit_id IS NULL) = (provider_merged_at IS NULL)),
  CHECK (state NOT IN ('closing_issues', 'completed') OR merge_commit_id IS NOT NULL),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
  CHECK (
    (state IN ('blocked', 'uncertain') AND failure IS NOT NULL)
    OR (state = 'closing_issues' AND (failure IS NULL OR failure = 'issue_closure_failed'))
    OR (state NOT IN ('blocked', 'uncertain', 'closing_issues') AND failure IS NULL)
  )
);

CREATE TABLE factory_feature_merge_issues (
  merge_id uuid NOT NULL REFERENCES factory_feature_merges(id) ON DELETE RESTRICT,
  work_item_id uuid NOT NULL,
  feature_id uuid NOT NULL,
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 48),
  issue jsonb NOT NULL CHECK (jsonb_typeof(issue) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'closing', 'closed', 'failed')),
  failure text CHECK (failure IN (
    'needs_authentication', 'access_denied', 'rate_limited', 'invalid_response', 'unavailable', 'timeout'
  )),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (merge_id, work_item_id),
  FOREIGN KEY (work_item_id, feature_id) REFERENCES factory_work_items(id, feature_id) ON DELETE RESTRICT,
  CHECK ((state = 'failed') = (failure IS NOT NULL)),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL))
);

CREATE TABLE factory_feature_merge_retry_requests (
  merge_id uuid NOT NULL REFERENCES factory_feature_merges(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (merge_id, request_id)
);

CREATE INDEX factory_feature_merge_progress ON factory_feature_merges(state, updated_at, id);

ALTER TABLE factory_activity DROP CONSTRAINT factory_activity_kind_check;
ALTER TABLE factory_activity ADD CONSTRAINT factory_activity_kind_check CHECK (kind IN (
  'draft_saved', 'plan_generated', 'plan_approved', 'item_queued', 'feature_cancelled',
  'issues_imported', 'issue_published', 'publication_failed', 'publication_retried',
  'execution_queued', 'execution_started', 'execution_blocked', 'item_verified',
  'gate_answered', 'correction_requested', 'correction_verified',
  'correction_published', 'correction_reviewed', 'merge_approved', 'merge_blocked',
  'merge_confirmed', 'issue_closed', 'merge_completed'
));

GRANT SELECT, INSERT ON factory_feature_merges, factory_feature_merge_issues,
  factory_feature_merge_retry_requests TO kestrel_runtime;
REVOKE UPDATE, DELETE ON factory_feature_merges, factory_feature_merge_issues,
  factory_feature_merge_retry_requests FROM kestrel_runtime;
GRANT UPDATE (state, failure, job_id, attempt_id, attempts, merge_attempted,
  merge_commit_id, provider_merged_at, retry_after, updated_at, completed_at)
  ON factory_feature_merges TO kestrel_runtime;
GRANT UPDATE (state, failure, attempts, closed_at, updated_at)
  ON factory_feature_merge_issues TO kestrel_runtime;
