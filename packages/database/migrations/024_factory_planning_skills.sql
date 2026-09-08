CREATE TABLE factory_planning_skill_versions (
  digest text PRIMARY KEY CHECK (digest ~ '^[a-f0-9]{64}$'),
  bundle jsonb NOT NULL CHECK (jsonb_typeof(bundle) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE factory_planning_skill_catalog (
  name text PRIMARY KEY,
  digest text NOT NULL REFERENCES factory_planning_skill_versions(digest),
  source_candidate_id text NOT NULL CHECK (source_candidate_id ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE factory_planning_skill_installs (
  actor_id uuid NOT NULL REFERENCES operators(id),
  request_id uuid NOT NULL,
  candidate_id text NOT NULL,
  digest text NOT NULL REFERENCES factory_planning_skill_versions(digest),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, request_id)
);
CREATE TABLE factory_feature_skill_selections (
  feature_id uuid NOT NULL REFERENCES factory_features(id),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000),
  request_id uuid NOT NULL,
  digests jsonb NOT NULL CHECK (jsonb_typeof(digests) = 'array' AND jsonb_array_length(digests) <= 8),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (feature_id, version),
  UNIQUE (feature_id, request_id)
);
ALTER TABLE factory_features ADD COLUMN skill_selection_version integer NOT NULL DEFAULT 0;
ALTER TABLE factory_planning_turns ADD COLUMN skill_digests jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE factory_planning_turns ADD COLUMN requested_skill_selection_version integer;
GRANT SELECT, INSERT ON factory_planning_skill_versions, factory_planning_skill_installs, factory_feature_skill_selections TO kestrel_runtime;
REVOKE UPDATE, DELETE ON factory_planning_skill_versions, factory_planning_skill_installs, factory_feature_skill_selections FROM kestrel_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON factory_planning_skill_catalog TO kestrel_runtime;
-- An accepted turn's Skill snapshot is immutable even while runtime state changes.
REVOKE UPDATE, DELETE ON factory_planning_turns FROM kestrel_runtime;
GRANT UPDATE (state, failure, question, started_at, completed_at) ON factory_planning_turns TO kestrel_runtime;
