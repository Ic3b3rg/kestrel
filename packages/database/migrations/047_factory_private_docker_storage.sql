ALTER TABLE factory_execution_containers ADD COLUMN private_storage jsonb
  CHECK (private_storage IS NULL OR jsonb_typeof(private_storage) = 'object');

ALTER TABLE factory_execution_containers ADD COLUMN private_storage_required boolean NOT NULL DEFAULT false;

GRANT UPDATE (private_storage) ON factory_execution_containers TO kestrel_runtime;
