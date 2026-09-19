-- Operator-selected corrections are bounded to one immutable published review.
CREATE TABLE factory_review_corrections (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  feature_id uuid NOT NULL REFERENCES factory_features(id) ON DELETE RESTRICT,
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
  tree_id text NOT NULL CHECK (tree_id ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'),
  instruction text NOT NULL CHECK (char_length(instruction) BETWEEN 1 AND 4000),
  finding_ids text[] NOT NULL CHECK (cardinality(finding_ids) BETWEEN 0 AND 40),
  findings jsonb NOT NULL CHECK (jsonb_typeof(findings) = 'array' AND jsonb_array_length(findings) BETWEEN 0 AND 40),
  publication_input jsonb NOT NULL CHECK (jsonb_typeof(publication_input) = 'object' AND octet_length(publication_input::text) <= 1048576),
  review_request_id uuid NOT NULL UNIQUE DEFAULT uuidv7(),
  state text NOT NULL DEFAULT 'executing' CHECK (state IN (
    'executing', 'gated', 'publishing', 'blocked', 'uncertain', 'reviewing', 'completed', 'failed', 'cancelled'
  )),
  failure text CHECK (failure IN (
    'authentication_required', 'usage_limit', 'runtime_unavailable', 'input_required',
    'verification_failed', 'source_changed', 'head_changed', 'push_rejected',
    'uncertain_write', 'retention_unavailable', 'review_failed', 'unavailable',
    'timeout', 'cancelled', 'retry_limit'
  )),
  current_run_id uuid UNIQUE,
  certificate_id uuid,
  job_id uuid,
  attempt_id uuid,
  push_attempted boolean NOT NULL DEFAULT false,
  push_confirmed_at timestamptz,
  replacement_pull_request jsonb,
  replacement_project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
  replacement_change_proposal_id uuid REFERENCES change_proposals(id) ON DELETE RESTRICT,
  replacement_review_revision_id uuid REFERENCES review_revisions(id) ON DELETE RESTRICT,
  replacement_manifest_digest text CHECK (replacement_manifest_digest IS NULL OR replacement_manifest_digest ~ '^[a-f0-9]{64}$'),
  replacement_review_workflow_id uuid REFERENCES review_workflows(id) ON DELETE RESTRICT,
  replacement_artifact_id uuid REFERENCES factory_conceptual_review_artifacts(id) ON DELETE RESTRICT,
  retry_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (feature_id, request_id),
  FOREIGN KEY (feature_id, plan_version) REFERENCES factory_plan_approvals(feature_id, plan_version),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((state IN ('gated', 'blocked', 'uncertain', 'failed', 'cancelled')) = (failure IS NOT NULL)),
  CHECK (state NOT IN ('reviewing', 'completed', 'failed') OR replacement_review_workflow_id IS NOT NULL),
  CHECK (replacement_review_workflow_id IS NULL OR state IN ('reviewing', 'completed', 'failed', 'cancelled')),
  CHECK (replacement_artifact_id IS NULL OR state = 'completed')
);

CREATE UNIQUE INDEX factory_review_correction_active_feature
  ON factory_review_corrections(feature_id)
  WHERE state IN ('executing', 'gated', 'publishing', 'blocked', 'uncertain', 'reviewing');
CREATE INDEX factory_review_correction_progress
  ON factory_review_corrections(state, updated_at, id);

ALTER TABLE factory_execution_runs
  DROP CONSTRAINT factory_execution_runs_purpose_check,
  DROP CONSTRAINT factory_execution_run_scope,
  DROP CONSTRAINT factory_execution_command_bounds,
  ADD COLUMN correction_id uuid REFERENCES factory_review_corrections(id) ON DELETE RESTRICT,
  ADD CONSTRAINT factory_execution_runs_purpose_check
    CHECK (purpose IN ('work_item', 'feature_verification', 'correction')),
  ADD CONSTRAINT factory_execution_run_scope CHECK (
    (purpose = 'work_item' AND work_item_id IS NOT NULL AND verification_manifest IS NULL
      AND initial_revision IS NULL AND correction_id IS NULL)
    OR (purpose = 'feature_verification' AND work_item_id IS NULL
      AND verification_manifest IS NOT NULL AND initial_revision IS NOT NULL AND correction_id IS NULL
      AND jsonb_typeof(verification_manifest) = 'array'
      AND jsonb_array_length(verification_manifest) BETWEEN 1 AND 480)
    OR (purpose = 'correction' AND work_item_id IS NULL AND verification_manifest IS NOT NULL
      AND initial_revision IS NOT NULL AND correction_id IS NOT NULL
      AND jsonb_typeof(verification_manifest) = 'array'
      AND jsonb_array_length(verification_manifest) BETWEEN 1 AND 480)
  ),
  ADD CONSTRAINT factory_execution_command_bounds CHECK (
    jsonb_typeof(accepted_commands) = 'array' AND jsonb_array_length(accepted_commands) BETWEEN 1 AND
      CASE WHEN purpose IN ('feature_verification', 'correction') THEN 480 ELSE 12 END
  ),
  ADD UNIQUE (id, correction_id);
CREATE UNIQUE INDEX factory_execution_correction_attempt
  ON factory_execution_runs(correction_id, attempt) WHERE purpose = 'correction';

ALTER TABLE factory_review_corrections
  ADD FOREIGN KEY (current_run_id, id) REFERENCES factory_execution_runs(id, correction_id) ON DELETE RESTRICT;

ALTER TABLE factory_verification_results
  DROP CONSTRAINT factory_verification_results_purpose_check,
  DROP CONSTRAINT factory_verification_result_position,
  ADD CONSTRAINT factory_verification_results_purpose_check
    CHECK (purpose IN ('work_item', 'feature_verification', 'correction')),
  ADD CONSTRAINT factory_verification_result_position CHECK (
    position BETWEEN 1 AND CASE WHEN purpose IN ('feature_verification', 'correction') THEN 480 ELSE 12 END
  );

ALTER TABLE factory_human_gates
  DROP CONSTRAINT factory_human_gates_purpose_check,
  DROP CONSTRAINT factory_human_gate_scope,
  ADD CONSTRAINT factory_human_gates_purpose_check
    CHECK (purpose IN ('work_item', 'feature_verification', 'correction')),
  ADD CONSTRAINT factory_human_gate_scope CHECK (
    (purpose = 'work_item' AND work_item_id IS NOT NULL) OR
    (purpose IN ('feature_verification', 'correction') AND work_item_id IS NULL)
  );

ALTER TABLE factory_feature_verifications
  DROP CONSTRAINT factory_feature_verifications_purpose_check,
  ADD CONSTRAINT factory_feature_verifications_purpose_check
    CHECK (purpose IN ('feature_verification', 'correction'));

ALTER TABLE factory_review_corrections
  ADD FOREIGN KEY (certificate_id) REFERENCES factory_feature_verifications(id) ON DELETE RESTRICT;

CREATE TABLE factory_review_correction_retry_requests (
  correction_id uuid NOT NULL REFERENCES factory_review_corrections(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (correction_id, request_id)
);

ALTER TABLE factory_activity DROP CONSTRAINT factory_activity_kind_check;
ALTER TABLE factory_activity ADD CONSTRAINT factory_activity_kind_check CHECK (kind IN (
  'draft_saved', 'plan_generated', 'plan_approved', 'item_queued', 'feature_cancelled',
  'issues_imported', 'issue_published', 'publication_failed', 'publication_retried',
  'execution_queued', 'execution_started', 'execution_blocked', 'item_verified',
  'gate_answered', 'correction_requested', 'correction_verified',
  'correction_published', 'correction_reviewed'
));

GRANT SELECT, INSERT ON factory_review_corrections, factory_review_correction_retry_requests TO kestrel_runtime;
REVOKE UPDATE, DELETE ON factory_review_corrections, factory_review_correction_retry_requests FROM kestrel_runtime;
GRANT UPDATE (state, failure, current_run_id, certificate_id, job_id, attempt_id,
  push_attempted, push_confirmed_at, replacement_pull_request, replacement_project_id,
  replacement_change_proposal_id, replacement_review_revision_id,
  replacement_manifest_digest, replacement_review_workflow_id, replacement_artifact_id,
  retry_after, updated_at, completed_at) ON factory_review_corrections TO kestrel_runtime;
GRANT UPDATE (certificate_id, updated_at) ON factory_feature_pr_publications TO kestrel_runtime;
GRANT UPDATE (target, payload) ON factory_feature_pr_operations TO kestrel_runtime;
GRANT UPDATE (pull_request) ON factory_feature_pr_results TO kestrel_runtime;
GRANT UPDATE (project_id, change_proposal_id, review_revision_id)
  ON factory_feature_pr_revisions TO kestrel_runtime;
-- Existing table-wide grants cover the new execution-run column. Its value is insert-only.
