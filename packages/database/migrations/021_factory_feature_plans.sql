ALTER TABLE factory_features DROP CONSTRAINT factory_features_state_check;
ALTER TABLE factory_features ADD CONSTRAINT factory_features_state_check
  CHECK (state IN ('planning', 'queued', 'cancelled'));
ALTER TABLE factory_features ADD COLUMN latest_plan_version integer;
ALTER TABLE factory_features ADD COLUMN approved_plan_version integer;
ALTER TABLE factory_features ADD COLUMN cancel_request_id uuid;

ALTER TABLE factory_planning_turns ADD COLUMN purpose text NOT NULL DEFAULT 'conversation'
  CHECK (purpose IN ('conversation', 'plan'));
ALTER TABLE factory_planning_turns ADD COLUMN expected_plan_version integer
  CHECK (expected_plan_version BETWEEN 1 AND 200);

CREATE TABLE factory_plan_versions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  feature_id uuid NOT NULL REFERENCES factory_features(id),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 200),
  based_on_version integer,
  request_id uuid NOT NULL,
  document jsonb NOT NULL,
  source_context jsonb,
  plan_markdown text NOT NULL CHECK (char_length(plan_markdown) BETWEEN 1 AND 256000),
  spec_markdown text NOT NULL CHECK (char_length(spec_markdown) BETWEEN 1 AND 256000),
  author text NOT NULL CHECK (author IN ('operator', 'assistant')),
  created_by uuid REFERENCES operators(id),
  source_turn_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (feature_id, version),
  UNIQUE (feature_id, request_id),
  UNIQUE (source_turn_id),
  FOREIGN KEY (source_turn_id, feature_id) REFERENCES factory_planning_turns(id, feature_id),
  FOREIGN KEY (feature_id, based_on_version) REFERENCES factory_plan_versions(feature_id, version),
  CHECK (based_on_version IS NOT DISTINCT FROM NULLIF(version - 1, 0)),
  CHECK ((author = 'operator' AND created_by IS NOT NULL AND source_turn_id IS NULL)
    OR (author = 'assistant' AND created_by IS NULL AND source_turn_id IS NOT NULL))
);
ALTER TABLE factory_features ADD FOREIGN KEY (id, latest_plan_version)
  REFERENCES factory_plan_versions(feature_id, version) DEFERRABLE INITIALLY DEFERRED;
GRANT SELECT, INSERT ON factory_plan_versions TO kestrel_runtime;

CREATE TABLE factory_plan_approvals (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  feature_id uuid NOT NULL,
  plan_version integer NOT NULL,
  request_id uuid NOT NULL,
  operator_id uuid NOT NULL REFERENCES operators(id),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (feature_id, plan_version),
  UNIQUE (feature_id, request_id),
  FOREIGN KEY (feature_id, plan_version) REFERENCES factory_plan_versions(feature_id, version)
);
ALTER TABLE factory_features ADD FOREIGN KEY (id, approved_plan_version)
  REFERENCES factory_plan_approvals(feature_id, plan_version) DEFERRABLE INITIALLY DEFERRED;
GRANT SELECT, INSERT ON factory_plan_approvals TO kestrel_runtime;

CREATE TABLE factory_work_items (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  feature_id uuid NOT NULL,
  plan_version integer NOT NULL,
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 48),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 40),
  board_column text NOT NULL DEFAULT 'todo' CHECK (board_column IN ('todo', 'in_progress', 'in_review', 'completed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (feature_id, plan_version, key),
  UNIQUE (feature_id, plan_version, position),
  UNIQUE (id, feature_id),
  FOREIGN KEY (feature_id, plan_version) REFERENCES factory_plan_approvals(feature_id, plan_version)
);
GRANT SELECT, INSERT ON factory_work_items TO kestrel_runtime;

CREATE TABLE factory_activity (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  feature_id uuid NOT NULL REFERENCES factory_features(id),
  work_item_id uuid,
  kind text NOT NULL CHECK (kind IN ('draft_saved', 'plan_generated', 'plan_approved', 'item_queued', 'feature_cancelled')),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (work_item_id, feature_id) REFERENCES factory_work_items(id, feature_id)
);
CREATE INDEX factory_activity_feature_order ON factory_activity(feature_id, created_at, id);
GRANT SELECT, INSERT ON factory_activity TO kestrel_runtime;

-- Migration 009 grants UPDATE/DELETE to future tables by default. Factory authority
-- and its history are append-only; remove those inherited default privileges.
REVOKE UPDATE, DELETE ON factory_plan_versions, factory_plan_approvals,
  factory_work_items, factory_activity FROM kestrel_runtime;
