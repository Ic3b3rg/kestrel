ALTER TABLE factory_execution_runs ADD COLUMN heavy_slot_claimed_at timestamptz;
-- A crash or heartbeat expiry cannot release this installation-wide capacity fence.
CREATE UNIQUE INDEX factory_execution_heavy_slot ON factory_execution_runs ((true))
  WHERE heavy_slot_claimed_at IS NOT NULL AND reservation_released_at IS NULL;

ALTER TABLE factory_execution_activity ADD COLUMN retain_detail boolean NOT NULL DEFAULT false;
