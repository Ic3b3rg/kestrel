-- Final Feature verification shares execution ownership without replaying Work Items.
ALTER TABLE factory_execution_runs ADD COLUMN purpose text NOT NULL DEFAULT 'work_item'
  CHECK (purpose IN ('work_item', 'feature_verification'));
ALTER TABLE factory_execution_runs ALTER COLUMN work_item_id DROP NOT NULL;
ALTER TABLE factory_execution_runs ADD COLUMN verification_manifest jsonb;
ALTER TABLE factory_execution_runs ADD COLUMN initial_revision jsonb;
ALTER TABLE factory_execution_runs ADD CONSTRAINT factory_execution_run_scope CHECK (
  (purpose = 'work_item' AND work_item_id IS NOT NULL AND verification_manifest IS NULL AND initial_revision IS NULL)
  OR (purpose = 'feature_verification' AND work_item_id IS NULL AND verification_manifest IS NOT NULL AND initial_revision IS NOT NULL
    AND jsonb_typeof(verification_manifest) = 'array' AND jsonb_array_length(verification_manifest) BETWEEN 1 AND 480)
);
ALTER TABLE factory_execution_runs ADD CONSTRAINT factory_execution_command_bounds CHECK (
  jsonb_typeof(accepted_commands) = 'array' AND jsonb_array_length(accepted_commands) BETWEEN 1 AND
    CASE WHEN purpose = 'feature_verification' THEN 480 ELSE 12 END
);
ALTER TABLE factory_execution_runs ADD UNIQUE (id, purpose);
ALTER TABLE factory_execution_runs ADD UNIQUE (id, feature_id, plan_version, purpose);
CREATE UNIQUE INDEX factory_execution_feature_verification_attempt
  ON factory_execution_runs(feature_id, plan_version, attempt) WHERE purpose = 'feature_verification';

ALTER TABLE factory_verification_results ADD COLUMN purpose text NOT NULL DEFAULT 'work_item'
  CHECK (purpose IN ('work_item', 'feature_verification'));
ALTER TABLE factory_verification_results DROP CONSTRAINT factory_verification_results_position_check;
ALTER TABLE factory_verification_results ADD CONSTRAINT factory_verification_result_position CHECK (
  position BETWEEN 1 AND CASE WHEN purpose = 'feature_verification' THEN 480 ELSE 12 END
);
ALTER TABLE factory_verification_results ADD FOREIGN KEY (run_id, purpose) REFERENCES factory_execution_runs(id, purpose);

ALTER TABLE factory_human_gates ADD COLUMN purpose text NOT NULL DEFAULT 'work_item'
  CHECK (purpose IN ('work_item', 'feature_verification'));
ALTER TABLE factory_human_gates ALTER COLUMN work_item_id DROP NOT NULL;
ALTER TABLE factory_human_gates ADD CONSTRAINT factory_human_gate_scope CHECK (
  (purpose = 'work_item' AND work_item_id IS NOT NULL) OR
  (purpose = 'feature_verification' AND work_item_id IS NULL)
);
ALTER TABLE factory_human_gates ADD FOREIGN KEY (run_id, feature_id, plan_version, purpose)
  REFERENCES factory_execution_runs(id, feature_id, plan_version, purpose);

CREATE TABLE factory_feature_verifications (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  feature_id uuid NOT NULL,
  plan_version integer NOT NULL,
  run_id uuid NOT NULL UNIQUE,
  purpose text NOT NULL DEFAULT 'feature_verification' CHECK (purpose = 'feature_verification'),
  source jsonb NOT NULL,
  revision jsonb NOT NULL,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'array' AND jsonb_array_length(manifest) BETWEEN 1 AND 480),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  evidence_ids uuid[] NOT NULL CHECK (cardinality(evidence_ids) BETWEEN 1 AND 480),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (run_id, feature_id, plan_version, purpose) REFERENCES factory_execution_runs(id, feature_id, plan_version, purpose),
  FOREIGN KEY (feature_id, plan_version) REFERENCES factory_plan_approvals(feature_id, plan_version)
);
CREATE UNIQUE INDEX factory_feature_verification_revision
  ON factory_feature_verifications(feature_id, plan_version, (revision->>'headCommitId'), manifest_digest);
GRANT SELECT, INSERT ON factory_feature_verifications TO kestrel_runtime;
REVOKE UPDATE, DELETE ON factory_feature_verifications FROM kestrel_runtime;
-- Existing table-wide INSERT/SELECT grants cover new columns. New run/gate inputs remain insert-only.
