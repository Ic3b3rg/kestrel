CREATE TABLE diagnostics (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded')),
  correlation_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  CHECK (started_at IS NULL OR started_at >= requested_at),
  CHECK (completed_at IS NULL OR (started_at IS NOT NULL AND completed_at >= started_at))
);

ALTER TABLE installations
ADD CONSTRAINT installations_current_diagnostic_fk
FOREIGN KEY (current_diagnostic_id) REFERENCES diagnostics(id);

CREATE INDEX diagnostics_installation_id_idx ON diagnostics (installation_id);

CREATE TABLE installation_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL CHECK (
    event_type IN (
      'installation.diagnostic.queued',
      'installation.diagnostic.running',
      'installation.diagnostic.succeeded'
    )
  ),
  aggregate_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
  correlation_id uuid NOT NULL,
  causation_id uuid,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (aggregate_id, aggregate_version)
);

CREATE TABLE event_streams (
  stream_name text PRIMARY KEY,
  first_available_event_id bigint NOT NULL DEFAULT 1 CHECK (first_available_event_id >= 1),
  latest_event_id bigint NOT NULL DEFAULT 0 CHECK (latest_event_id >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (first_available_event_id <= latest_event_id + 1)
);

INSERT INTO event_streams (stream_name)
VALUES ('installation');
