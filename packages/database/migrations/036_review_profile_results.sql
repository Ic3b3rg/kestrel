ALTER TABLE review_workflow_attempts ADD COLUMN runtime_profile_result jsonb;
COMMENT ON COLUMN review_workflow_attempts.runtime_profile_result IS
  'Runtime-reported model controls for this exact attempt; the requested lifecycle profile remains immutable in analysis_configuration.';

INSERT INTO lifecycle_phase_profiles (project_id, phase, version, settings)
SELECT NULL, phase, 1, jsonb_build_object('model', jsonb_build_object('kind', 'explicit', 'value', selected_model_id))
FROM codex_review_model_preferences CROSS JOIN (VALUES ('implementation'), ('review'), ('corrections')) AS phases(phase)
WHERE selected_model_id IS NOT NULL
ON CONFLICT (project_id, phase) DO NOTHING;
