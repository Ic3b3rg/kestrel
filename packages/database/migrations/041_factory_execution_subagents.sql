ALTER TABLE factory_execution_activity
  ADD COLUMN agent_path text CHECK (char_length(agent_path) BETWEEN 1 AND 256);

ALTER TABLE factory_execution_activity DROP CONSTRAINT factory_execution_activity_kind_check;
ALTER TABLE factory_execution_activity ADD CONSTRAINT factory_execution_activity_kind_check
  CHECK (kind IN ('runtime', 'reasoning', 'command', 'file_change', 'subagent', 'question', 'verification', 'lifecycle'));

ALTER TABLE factory_execution_activity DROP CONSTRAINT factory_execution_activity_item_state_check;
ALTER TABLE factory_execution_activity ADD CONSTRAINT factory_execution_activity_item_state_check
  CHECK (item_state IN ('started', 'completed', 'failed'));
