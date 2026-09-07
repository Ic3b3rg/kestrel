CREATE TABLE factory_features (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id uuid NOT NULL REFERENCES projects(id),
  created_by uuid NOT NULL REFERENCES operators(id),
  request_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  state text NOT NULL DEFAULT 'planning' CHECK (state = 'planning'),
  runtime_thread_id text CHECK (char_length(runtime_thread_id) BETWEEN 1 AND 128),
  planning_context jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (created_by, request_id)
);
CREATE INDEX factory_features_project ON factory_features(project_id, created_at, id);
GRANT SELECT, INSERT, UPDATE ON factory_features TO kestrel_runtime;

CREATE TABLE factory_planning_messages (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  feature_id uuid NOT NULL REFERENCES factory_features(id),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 32000),
  reply_to_turn_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((role = 'user' AND reply_to_turn_id IS NULL) OR (role = 'assistant' AND reply_to_turn_id IS NOT NULL)),
  UNIQUE (id, feature_id)
);
CREATE TABLE factory_planning_turns (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  feature_id uuid NOT NULL REFERENCES factory_features(id),
  message_id uuid NOT NULL,
  request_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  failure text CHECK (failure IN ('unavailable', 'authentication', 'usage_limit', 'permission_required', 'input_required', 'timeout', 'cancelled', 'interrupted', 'invalid_response', 'source_unavailable')),
  question text CHECK (char_length(question) <= 4000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (feature_id, request_id),
  UNIQUE (id, feature_id),
  FOREIGN KEY (message_id, feature_id) REFERENCES factory_planning_messages(id, feature_id),
  CHECK ((state IN ('queued', 'running') AND completed_at IS NULL AND failure IS NULL)
    OR (state = 'completed' AND completed_at IS NOT NULL AND failure IS NULL)
    OR (state IN ('failed', 'cancelled') AND completed_at IS NOT NULL AND failure IS NOT NULL))
);
ALTER TABLE factory_planning_messages ADD FOREIGN KEY (reply_to_turn_id, feature_id)
  REFERENCES factory_planning_turns(id, feature_id);
CREATE UNIQUE INDEX factory_one_pending_turn ON factory_planning_turns(feature_id) WHERE state IN ('queued', 'running');
CREATE INDEX factory_messages_order ON factory_planning_messages(feature_id, created_at, id);
CREATE INDEX factory_turns_order ON factory_planning_turns(feature_id, created_at, id);
GRANT SELECT, INSERT ON factory_planning_messages TO kestrel_runtime;
GRANT SELECT, INSERT, UPDATE ON factory_planning_turns TO kestrel_runtime;
