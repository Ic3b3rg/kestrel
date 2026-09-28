-- Existing approvals retain their historical authority. New interviews only publish.
ALTER TABLE factory_features ADD COLUMN execution_mode text NOT NULL DEFAULT 'individual'
  CHECK (execution_mode IN ('individual', 'authorized'));
UPDATE factory_features SET execution_mode = 'authorized' WHERE approved_plan_version IS NOT NULL;

-- A selected issue gets its own execution lifecycle, while its original identity and
-- immutable requirements remain on the interview. This is an authorization, not publication.
CREATE TABLE factory_work_item_starts (
  work_item_id uuid PRIMARY KEY REFERENCES factory_work_items(id),
  feature_id uuid NOT NULL,
  plan_version integer NOT NULL,
  execution_feature_id uuid NOT NULL UNIQUE REFERENCES factory_features(id),
  execution_work_item_id uuid NOT NULL UNIQUE REFERENCES factory_work_items(id),
  request_id uuid NOT NULL,
  operator_id uuid NOT NULL REFERENCES operators(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (operator_id, request_id),
  FOREIGN KEY (work_item_id, feature_id) REFERENCES factory_work_items(id, feature_id),
  FOREIGN KEY (feature_id, plan_version) REFERENCES factory_plan_approvals(feature_id, plan_version),
  FOREIGN KEY (execution_work_item_id, execution_feature_id) REFERENCES factory_work_items(id, feature_id)
);
GRANT SELECT, INSERT ON factory_work_item_starts TO kestrel_runtime;
REVOKE UPDATE, DELETE ON factory_work_item_starts FROM kestrel_runtime;
