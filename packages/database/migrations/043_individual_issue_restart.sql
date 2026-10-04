-- Preserve cancelled lifecycles and every accepted request while allowing a fresh start.
ALTER TABLE factory_work_item_starts DROP CONSTRAINT factory_work_item_starts_pkey;
ALTER TABLE factory_work_item_starts ADD PRIMARY KEY (work_item_id, execution_feature_id);
CREATE INDEX factory_work_item_starts_latest
  ON factory_work_item_starts (work_item_id, created_at DESC, execution_feature_id DESC);

CREATE TABLE factory_work_item_start_requests (
  operator_id uuid NOT NULL REFERENCES operators(id),
  request_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  execution_feature_id uuid NOT NULL,
  PRIMARY KEY (operator_id, request_id),
  FOREIGN KEY (work_item_id, execution_feature_id)
    REFERENCES factory_work_item_starts(work_item_id, execution_feature_id)
);
INSERT INTO factory_work_item_start_requests
  SELECT operator_id, request_id, work_item_id, execution_feature_id
  FROM factory_work_item_starts;
GRANT SELECT, INSERT ON factory_work_item_start_requests TO kestrel_runtime;
REVOKE UPDATE, DELETE ON factory_work_item_start_requests FROM kestrel_runtime;
