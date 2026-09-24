ALTER TABLE factory_features ADD COLUMN planning_settings jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE factory_planning_turns ADD COLUMN requested_planning_settings jsonb;
ALTER TABLE factory_planning_starts ADD COLUMN requested_planning_settings jsonb;
