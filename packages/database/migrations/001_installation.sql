CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE installations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  state text NOT NULL DEFAULT 'ready' CHECK (
    state IN (
      'ready',
      'diagnostic_queued',
      'diagnostic_running',
      'diagnostic_succeeded'
    )
  ),
  current_diagnostic_id uuid,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX installations_singleton ON installations ((true));

INSERT INTO installations (state)
VALUES ('ready');
