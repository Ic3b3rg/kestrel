ALTER TABLE review_revisions
ADD CONSTRAINT review_revisions_id_change_proposal_unique
UNIQUE (id, change_proposal_id);

CREATE TABLE review_workflows (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  change_proposal_id uuid NOT NULL REFERENCES change_proposals(id) ON DELETE CASCADE,
  review_revision_id uuid NOT NULL,
  change_intent_id uuid NOT NULL,
  requested_by_operator_id uuid NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  analysis_configuration jsonb NOT NULL CHECK (
    jsonb_typeof(analysis_configuration) = 'object'
    AND octet_length(analysis_configuration::text) <= 8192
  ),
  authority jsonb NOT NULL CHECK (
    jsonb_typeof(authority) = 'object'
    AND octet_length(authority::text) <= 2048
  ),
  resource_envelope jsonb NOT NULL CHECK (
    jsonb_typeof(resource_envelope) = 'object'
    AND octet_length(resource_envelope::text) <= 8192
  ),
  workflow_state text NOT NULL CHECK (workflow_state = 'queued'),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (change_proposal_id, input_digest),
  FOREIGN KEY (change_proposal_id, project_id)
    REFERENCES change_proposals (id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (review_revision_id, change_proposal_id)
    REFERENCES review_revisions (id, change_proposal_id) ON DELETE RESTRICT,
  FOREIGN KEY (change_intent_id, change_proposal_id)
    REFERENCES change_intents (id, change_proposal_id) ON DELETE RESTRICT
);

CREATE FUNCTION enforce_review_workflow_frozen_inputs()
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
    OLD.requested_at
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
    NEW.requested_at
  ) THEN
    RAISE EXCEPTION 'Review Workflow inputs are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER review_workflows_frozen_inputs
BEFORE UPDATE ON review_workflows
FOR EACH ROW
EXECUTE FUNCTION enforce_review_workflow_frozen_inputs();

CREATE FUNCTION reject_review_workflow_deletion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Review Workflow records cannot be deleted or truncated';
END;
$$;

CREATE TRIGGER review_workflows_no_delete
BEFORE DELETE OR TRUNCATE ON review_workflows
FOR EACH STATEMENT
EXECUTE FUNCTION reject_review_workflow_deletion();

REVOKE ALL PRIVILEGES ON review_workflows FROM kestrel_runtime;
GRANT SELECT, INSERT ON review_workflows TO kestrel_runtime;

CREATE INDEX review_workflows_proposal_requested_idx
ON review_workflows (change_proposal_id, requested_at DESC, id);

COMMENT ON TABLE review_workflows IS
'Operator-started Review Workflows with transactionally frozen exact input bindings.';
