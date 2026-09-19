ALTER TABLE review_workflows
  DROP CONSTRAINT review_workflows_workflow_state_check,
  DROP CONSTRAINT review_workflows_change_proposal_id_input_digest_key,
  ADD COLUMN feature_id uuid REFERENCES factory_features(id) ON DELETE RESTRICT,
  ADD COLUMN request_id uuid,
  ADD COLUMN factory_input jsonb,
  ADD COLUMN job_id uuid,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
  ADD COLUMN maximum_attempts integer NOT NULL DEFAULT 1 CHECK (maximum_attempts BETWEEN 1 AND 10),
  ADD COLUMN attempt_id uuid,
  ADD COLUMN failure_code text,
  ADD COLUMN artifact_id uuid,
  ADD COLUMN observed_head_commit_id text CHECK (
    observed_head_commit_id IS NULL OR observed_head_commit_id ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'
  ),
  ADD COLUMN head_observed_at timestamptz,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN finished_at timestamptz,
  ADD CONSTRAINT review_workflows_workflow_state_check CHECK (
    workflow_state IN ('queued', 'running', 'published', 'failed')
  ),
  ADD CONSTRAINT review_workflows_factory_shape CHECK (
    (feature_id IS NULL AND request_id IS NULL AND factory_input IS NULL AND job_id IS NULL)
    OR
    (feature_id IS NOT NULL AND request_id IS NOT NULL AND factory_input IS NOT NULL AND job_id IS NOT NULL
      AND jsonb_typeof(factory_input) = 'object'
      AND octet_length(factory_input::text) <= 1048576)
  ),
  ADD CONSTRAINT review_workflows_head_observation_shape CHECK (
    (observed_head_commit_id IS NULL) = (head_observed_at IS NULL)
  ),
  ADD CONSTRAINT review_workflows_terminal_shape CHECK (
    (workflow_state IN ('queued', 'running') AND finished_at IS NULL AND artifact_id IS NULL)
    OR (workflow_state = 'published' AND finished_at IS NOT NULL AND artifact_id IS NOT NULL AND failure_code IS NULL)
    OR (workflow_state = 'failed' AND finished_at IS NOT NULL AND artifact_id IS NULL AND failure_code IS NOT NULL)
  );

CREATE UNIQUE INDEX review_workflows_legacy_input_unique
ON review_workflows (change_proposal_id, input_digest)
WHERE feature_id IS NULL;

CREATE UNIQUE INDEX review_workflows_factory_request_unique
ON review_workflows (feature_id, request_id)
WHERE feature_id IS NOT NULL;

CREATE UNIQUE INDEX review_workflows_factory_active_unique
ON review_workflows (change_proposal_id)
WHERE feature_id IS NOT NULL AND workflow_state IN ('queued', 'running');

CREATE INDEX review_workflows_factory_feature_requested_idx
ON review_workflows (feature_id, requested_at DESC, id DESC)
WHERE feature_id IS NOT NULL;

CREATE TABLE review_workflow_attempts (
  workflow_id uuid NOT NULL REFERENCES review_workflows(id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 10),
  attempt_id uuid NOT NULL UNIQUE,
  attempt_state text NOT NULL CHECK (attempt_state IN ('running', 'published', 'failed')),
  container_name text CHECK (container_name IS NULL OR octet_length(container_name) <= 128),
  container_id text CHECK (container_id IS NULL OR container_id ~ '^[a-f0-9]{64}$'),
  docker_daemon_id text CHECK (docker_daemon_id IS NULL OR octet_length(docker_daemon_id) <= 256),
  container_stopped_at timestamptz,
  runtime_thread_id text CHECK (runtime_thread_id IS NULL OR octet_length(runtime_thread_id) <= 512),
  runtime_turn_id text CHECK (runtime_turn_id IS NULL OR octet_length(runtime_turn_id) <= 512),
  failure_code text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  PRIMARY KEY (workflow_id, attempt_number)
);

CREATE TABLE factory_conceptual_review_artifacts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  workflow_id uuid NOT NULL UNIQUE REFERENCES review_workflows(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  feature_id uuid NOT NULL REFERENCES factory_features(id) ON DELETE RESTRICT,
  change_proposal_id uuid NOT NULL REFERENCES change_proposals(id) ON DELETE RESTRICT,
  review_revision_id uuid NOT NULL REFERENCES review_revisions(id) ON DELETE RESTRICT,
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  artifact_status text NOT NULL CHECK (artifact_status IN ('complete', 'partial')),
  artifact jsonb NOT NULL CHECK (
    jsonb_typeof(artifact) = 'object' AND octet_length(artifact::text) <= 2097152
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, workflow_id)
);

ALTER TABLE review_workflows
  ADD CONSTRAINT review_workflows_artifact_identity
  FOREIGN KEY (artifact_id, id)
  REFERENCES factory_conceptual_review_artifacts (id, workflow_id)
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION enforce_review_workflow_frozen_inputs()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF (
    OLD.project_id,
    OLD.change_proposal_id,
    OLD.review_revision_id,
    OLD.change_intent_id,
    OLD.requested_by_operator_id,
    OLD.input_digest,
    OLD.analysis_configuration,
    OLD.authority,
    OLD.resource_envelope,
    OLD.requested_at,
    OLD.feature_id,
    OLD.request_id,
    OLD.factory_input,
    OLD.maximum_attempts
  ) IS DISTINCT FROM (
    NEW.project_id,
    NEW.change_proposal_id,
    NEW.review_revision_id,
    NEW.change_intent_id,
    NEW.requested_by_operator_id,
    NEW.input_digest,
    NEW.analysis_configuration,
    NEW.authority,
    NEW.resource_envelope,
    NEW.requested_at,
    NEW.feature_id,
    NEW.request_id,
    NEW.factory_input,
    NEW.maximum_attempts
  ) THEN
    RAISE EXCEPTION 'Review Workflow inputs are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION reject_factory_conceptual_review_artifact_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Conceptual Review artifacts are immutable';
END;
$$;

CREATE TRIGGER factory_conceptual_review_artifacts_no_update
BEFORE UPDATE ON factory_conceptual_review_artifacts
FOR EACH STATEMENT EXECUTE FUNCTION reject_factory_conceptual_review_artifact_mutation();

CREATE TRIGGER factory_conceptual_review_artifacts_no_delete
BEFORE DELETE OR TRUNCATE ON factory_conceptual_review_artifacts
FOR EACH STATEMENT EXECUTE FUNCTION reject_factory_conceptual_review_artifact_mutation();

REVOKE ALL PRIVILEGES ON review_workflow_attempts FROM kestrel_runtime;
GRANT SELECT, INSERT, UPDATE ON review_workflow_attempts TO kestrel_runtime;
GRANT UPDATE ON review_workflows TO kestrel_runtime;
REVOKE ALL PRIVILEGES ON factory_conceptual_review_artifacts FROM kestrel_runtime;
GRANT SELECT, INSERT ON factory_conceptual_review_artifacts TO kestrel_runtime;

COMMENT ON TABLE factory_conceptual_review_artifacts IS
'Immutable, validated requirements-first review graphs for exact Factory Feature revisions.';
