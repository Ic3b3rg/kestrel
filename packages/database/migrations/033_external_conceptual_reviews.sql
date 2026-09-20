ALTER TABLE review_workflows
  DROP CONSTRAINT review_workflows_factory_shape,
  ADD CONSTRAINT review_workflows_factory_shape CHECK (
    (feature_id IS NULL AND request_id IS NULL AND factory_input IS NULL AND job_id IS NULL)
    OR
    (request_id IS NOT NULL AND factory_input IS NOT NULL AND job_id IS NOT NULL
      AND jsonb_typeof(factory_input) = 'object'
      AND octet_length(factory_input::text) <= 1048576)
  );

DROP INDEX review_workflows_legacy_input_unique;
CREATE UNIQUE INDEX review_workflows_legacy_input_unique
ON review_workflows (change_proposal_id, input_digest)
WHERE feature_id IS NULL AND factory_input IS NULL;

CREATE UNIQUE INDEX review_workflows_external_request_unique
ON review_workflows (change_proposal_id, request_id)
WHERE feature_id IS NULL AND factory_input IS NOT NULL;

CREATE UNIQUE INDEX review_workflows_external_active_unique
ON review_workflows (change_proposal_id)
WHERE feature_id IS NULL
  AND factory_input IS NOT NULL
  AND workflow_state IN ('queued', 'running');

CREATE INDEX review_workflows_external_proposal_requested_idx
ON review_workflows (change_proposal_id, requested_at DESC, id DESC)
WHERE feature_id IS NULL AND factory_input IS NOT NULL;

ALTER TABLE factory_conceptual_review_artifacts
  ALTER COLUMN feature_id DROP NOT NULL;

COMMENT ON TABLE factory_conceptual_review_artifacts IS
'Immutable, validated requirements-first review graphs for exact retained revisions.';
