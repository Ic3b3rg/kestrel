ALTER TABLE factory_human_gates ADD COLUMN workspace_restoration jsonb
  CHECK (workspace_restoration IS NULL OR jsonb_typeof(workspace_restoration) = 'object');

GRANT UPDATE (workspace_restoration) ON factory_human_gates TO kestrel_runtime;
