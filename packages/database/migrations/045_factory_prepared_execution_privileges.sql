-- Execution custody uses explicit column grants, rather than table-wide UPDATE.
GRANT UPDATE (heavy_slot_claimed_at) ON factory_execution_runs TO kestrel_runtime;
