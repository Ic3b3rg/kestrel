ALTER TABLE factory_features DROP CONSTRAINT factory_features_state_check;
ALTER TABLE factory_features ADD CONSTRAINT factory_features_state_check
  CHECK (state IN ('planning', 'queued', 'implementing', 'gated', 'in_review', 'cancelled'));

CREATE TABLE factory_feature_workspaces (
  feature_id uuid PRIMARY KEY REFERENCES factory_features(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  repository_id text NOT NULL,
  source_identity text NOT NULL,
  base_commit_id text NOT NULL,
  object_format text NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
  branch text NOT NULL,
  head_commit_id text NOT NULL,
  tree_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE factory_execution_runs (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  feature_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id),
  work_item_id uuid NOT NULL,
  plan_version integer NOT NULL,
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 20),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'verifying', 'stopping', 'verified', 'blocked', 'cancelled', 'interrupted')),
  owner_instance_id uuid,
  source jsonb,
  accepted_commands jsonb NOT NULL,
  runtime jsonb,
  revision jsonb,
  failure text,
  question text CHECK (char_length(question) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  heartbeat_at timestamptz,
  completed_at timestamptz,
  stop_requested_at timestamptz,
  -- An expired job or heartbeat never proves that a workspace writer stopped.
  reservation_released_at timestamptz,
  UNIQUE (id, feature_id),
  UNIQUE (work_item_id, attempt),
  FOREIGN KEY (work_item_id, feature_id) REFERENCES factory_work_items(id, feature_id),
  FOREIGN KEY (feature_id, plan_version) REFERENCES factory_plan_approvals(feature_id, plan_version)
);
CREATE UNIQUE INDEX factory_execution_project_writer ON factory_execution_runs(project_id)
  WHERE reservation_released_at IS NULL;
CREATE INDEX factory_execution_feature_runs ON factory_execution_runs(feature_id, work_item_id, attempt);

CREATE TABLE factory_execution_containers (
  name text PRIMARY KEY CHECK (name ~ '^kestrel-factory-[a-f0-9-]{32,64}$'),
  run_id uuid NOT NULL REFERENCES factory_execution_runs(id),
  phase text NOT NULL CHECK (phase IN ('implementation', 'verification')),
  container_id text CHECK (container_id ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  stopped_at timestamptz
);

CREATE TABLE factory_execution_activity (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  run_id uuid NOT NULL REFERENCES factory_execution_runs(id),
  kind text NOT NULL CHECK (kind IN ('runtime', 'command', 'file_change', 'question', 'verification', 'lifecycle')),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX factory_execution_activity_order ON factory_execution_activity(run_id, created_at, id);

CREATE TABLE factory_verification_results (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  run_id uuid NOT NULL REFERENCES factory_execution_runs(id),
  round integer NOT NULL CHECK (round BETWEEN 1 AND 3),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 12),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, round, position)
);

ALTER TABLE factory_activity DROP CONSTRAINT factory_activity_kind_check;
ALTER TABLE factory_activity ADD CONSTRAINT factory_activity_kind_check CHECK (kind IN (
  'draft_saved', 'plan_generated', 'plan_approved', 'item_queued', 'feature_cancelled',
  'issues_imported', 'issue_published', 'publication_failed', 'publication_retried',
  'execution_queued', 'execution_started', 'execution_blocked', 'item_verified'
));

GRANT SELECT, INSERT ON factory_feature_workspaces, factory_execution_runs,
  factory_execution_activity, factory_verification_results TO kestrel_runtime;
REVOKE UPDATE, DELETE ON factory_feature_workspaces, factory_execution_runs,
  factory_execution_activity, factory_verification_results FROM kestrel_runtime;
GRANT UPDATE (head_commit_id, tree_id) ON factory_feature_workspaces TO kestrel_runtime;
GRANT UPDATE (state, owner_instance_id, runtime, revision, failure, question, started_at,
  heartbeat_at, completed_at, stop_requested_at, reservation_released_at) ON factory_execution_runs TO kestrel_runtime;
GRANT UPDATE (board_column) ON factory_work_items TO kestrel_runtime;
GRANT SELECT, INSERT ON factory_execution_containers TO kestrel_runtime;
REVOKE UPDATE, DELETE ON factory_execution_containers FROM kestrel_runtime;
GRANT UPDATE (container_id, stopped_at) ON factory_execution_containers TO kestrel_runtime;
