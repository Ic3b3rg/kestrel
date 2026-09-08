ALTER TABLE factory_features ADD COLUMN title_source text NOT NULL DEFAULT 'operator'
  CHECK (title_source IN ('operator', 'pending', 'assistant'));
ALTER TABLE factory_features ADD COLUMN initial_title text
  CHECK (char_length(initial_title) BETWEEN 1 AND 160);
UPDATE factory_features SET initial_title = title;

CREATE TABLE factory_planning_starts (
  feature_id uuid PRIMARY KEY REFERENCES factory_features(id),
  actor_id uuid NOT NULL REFERENCES operators(id),
  request_id uuid NOT NULL,
  first_prompt text NOT NULL CHECK (char_length(first_prompt) BETWEEN 1 AND 16000),
  skill_digests jsonb NOT NULL CHECK (jsonb_typeof(skill_digests) = 'array' AND jsonb_array_length(skill_digests) <= 8),
  message_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (actor_id, request_id),
  FOREIGN KEY (message_id, feature_id) REFERENCES factory_planning_messages(id, feature_id),
  FOREIGN KEY (turn_id, feature_id) REFERENCES factory_planning_turns(id, feature_id)
);

CREATE TABLE factory_feature_renames (
  actor_id uuid NOT NULL REFERENCES operators(id),
  request_id uuid NOT NULL,
  feature_id uuid NOT NULL REFERENCES factory_features(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, request_id)
);
CREATE INDEX factory_feature_rename_history ON factory_feature_renames(feature_id, created_at);

GRANT SELECT, INSERT ON factory_planning_starts, factory_feature_renames TO kestrel_runtime;
REVOKE UPDATE, DELETE ON factory_planning_starts, factory_feature_renames FROM kestrel_runtime;
