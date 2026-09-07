CREATE TABLE codex_review_model_preferences (
  installation_id uuid PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  selected_model_id text NOT NULL CHECK (
    octet_length(selected_model_id) <= 128
    AND selected_model_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
  ),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL PRIVILEGES ON codex_review_model_preferences FROM kestrel_runtime;
GRANT SELECT, INSERT, UPDATE ON codex_review_model_preferences TO kestrel_runtime;

COMMENT ON TABLE codex_review_model_preferences IS
'Installation default model candidate for future Codex subscription Review Workflows.';
