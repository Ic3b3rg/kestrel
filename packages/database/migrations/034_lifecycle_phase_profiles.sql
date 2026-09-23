CREATE TABLE lifecycle_phase_profiles (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN ('planning', 'implementation', 'review', 'corrections')),
  version integer NOT NULL CHECK (version > 0),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE NULLS NOT DISTINCT (project_id, phase)
);
GRANT SELECT, INSERT, UPDATE ON lifecycle_phase_profiles TO kestrel_runtime;
GRANT USAGE, SELECT ON SEQUENCE lifecycle_phase_profiles_id_seq TO kestrel_runtime;

INSERT INTO lifecycle_phase_profiles (project_id, phase, version, settings)
SELECT NULL, 'planning', 1, jsonb_build_object('model', jsonb_build_object('kind', 'explicit', 'value', selected_model_id))
FROM codex_review_model_preferences WHERE selected_model_id IS NOT NULL LIMIT 1;

ALTER TABLE factory_planning_turns ADD COLUMN lifecycle_profile jsonb;
ALTER TABLE factory_planning_turns ADD COLUMN runtime_profile_result jsonb;
GRANT UPDATE (runtime_profile_result) ON factory_planning_turns TO kestrel_runtime;
COMMENT ON COLUMN factory_planning_turns.lifecycle_profile IS 'Immutable profile and exact Skill bundles frozen with message acceptance. NULL identifies pre-profile work; no settings fallback is authorized.';
