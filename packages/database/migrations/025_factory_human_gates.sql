CREATE TABLE factory_human_gates (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  feature_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  run_id uuid NOT NULL UNIQUE,
  plan_version integer NOT NULL,
  reason text NOT NULL CHECK (reason IN (
    'unavailable', 'authentication', 'usage_limit', 'sandbox_unavailable',
    'source_unavailable', 'source_changed', 'permission_required', 'input_required',
    'timeout', 'cancelled', 'interrupted', 'invalid_response',
    'verification_failed', 'revision_changed', 'stop_unconfirmed'
  )),
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 4000),
  required_decision text NOT NULL CHECK (required_decision IN (
    'clarify_within_plan', 'retry_within_plan', 'inspect_workspace', 'inspect_environment'
  )),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_id uuid,
  resolved_by uuid REFERENCES operators(id),
  decision text CHECK (decision IN ('resume_within_plan', 'requires_plan_change')),
  answer text CHECK (char_length(answer) BETWEEN 1 AND 4000),
  resolved_at timestamptz,
  UNIQUE (id, feature_id),
  UNIQUE (feature_id, request_id),
  FOREIGN KEY (run_id, feature_id) REFERENCES factory_execution_runs(id, feature_id),
  FOREIGN KEY (work_item_id, feature_id) REFERENCES factory_work_items(id, feature_id),
  FOREIGN KEY (feature_id, plan_version) REFERENCES factory_plan_approvals(feature_id, plan_version),
  CHECK (
    (request_id IS NULL AND resolved_by IS NULL AND decision IS NULL AND answer IS NULL AND resolved_at IS NULL)
    OR
    (request_id IS NOT NULL AND resolved_by IS NOT NULL AND decision IS NOT NULL AND answer IS NOT NULL AND resolved_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX factory_human_gate_open_feature ON factory_human_gates(feature_id)
  WHERE resolved_at IS NULL;
CREATE INDEX factory_human_gate_feature_history ON factory_human_gates(feature_id, created_at, id);

ALTER TABLE factory_execution_runs ADD COLUMN resume_gate_id uuid UNIQUE;
ALTER TABLE factory_execution_runs ADD FOREIGN KEY (resume_gate_id, feature_id)
  REFERENCES factory_human_gates(id, feature_id);

GRANT SELECT, INSERT ON factory_human_gates TO kestrel_runtime;
REVOKE UPDATE, DELETE ON factory_human_gates FROM kestrel_runtime;
GRANT UPDATE (request_id, resolved_by, decision, answer, resolved_at) ON factory_human_gates TO kestrel_runtime;
-- The successor's gate identity is insert-only, like its approved execution inputs.

ALTER TABLE factory_activity DROP CONSTRAINT factory_activity_kind_check;
ALTER TABLE factory_activity ADD CONSTRAINT factory_activity_kind_check CHECK (kind IN (
  'draft_saved', 'plan_generated', 'plan_approved', 'item_queued', 'feature_cancelled',
  'issues_imported', 'issue_published', 'publication_failed', 'publication_retried',
  'execution_queued', 'execution_started', 'execution_blocked', 'item_verified',
  'gate_answered'
));
