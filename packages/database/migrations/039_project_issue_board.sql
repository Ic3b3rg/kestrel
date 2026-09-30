CREATE TABLE project_board_settings (
  project_id uuid PRIMARY KEY REFERENCES projects(id),
  ready_label text NOT NULL DEFAULT 'ready-for-agent' CHECK (length(ready_label) BETWEEN 1 AND 100)
);

CREATE TABLE project_issue_observations (
  project_id uuid NOT NULL REFERENCES projects(id),
  observation_key text NOT NULL,
  value jsonb NOT NULL,
  PRIMARY KEY (project_id, observation_key)
);

-- The explicit board command, rather than a provider event, grants development authority.
CREATE TABLE project_issue_starts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id uuid NOT NULL REFERENCES projects(id),
  actor_id uuid NOT NULL REFERENCES operators(id),
  request_id uuid NOT NULL,
  repository_id text NOT NULL,
  issue_id text NOT NULL,
  issue_number integer NOT NULL,
  issue_url text NOT NULL,
  title text NOT NULL,
  ready_label text NOT NULL,
  plan_request_id uuid NOT NULL DEFAULT uuidv7(),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','preparing','running','blocked','done')),
  feature_id uuid REFERENCES factory_features(id),
  snapshot jsonb,
  message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (actor_id, request_id)
);
CREATE UNIQUE INDEX project_issue_start_active ON project_issue_starts(repository_id, issue_id)
  WHERE state <> 'done';

GRANT SELECT, INSERT, UPDATE ON project_board_settings, project_issue_observations, project_issue_starts TO kestrel_runtime;
