ALTER TABLE factory_execution_activity
  ADD COLUMN item_id text CHECK (char_length(item_id) BETWEEN 1 AND 256),
  ADD COLUMN item_state text CHECK (item_state IN ('started', 'completed')),
  ADD COLUMN detail text CHECK (char_length(detail) BETWEEN 1 AND 8192),
  ADD COLUMN exit_code integer;

ALTER TABLE factory_execution_activity DROP CONSTRAINT factory_execution_activity_kind_check;
ALTER TABLE factory_execution_activity ADD CONSTRAINT factory_execution_activity_kind_check
  CHECK (kind IN ('runtime', 'reasoning', 'command', 'file_change', 'question', 'verification', 'lifecycle'));

ALTER TABLE factory_execution_runs
  ADD COLUMN final_summary text CHECK (char_length(final_summary) BETWEEN 1 AND 4000);

GRANT UPDATE (detail) ON factory_execution_activity TO kestrel_runtime;
GRANT UPDATE (final_summary) ON factory_execution_runs TO kestrel_runtime;
