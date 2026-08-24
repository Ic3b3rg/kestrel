ALTER TABLE installation_events
ADD COLUMN schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1);

ALTER TABLE event_streams
ADD COLUMN retention_floor_event_id bigint NOT NULL DEFAULT 0 CHECK (
  retention_floor_event_id >= 0 AND retention_floor_event_id <= latest_event_id
);

UPDATE event_streams
SET retention_floor_event_id = CASE
  WHEN (SELECT MIN(aggregate_version) FROM installation_events) > 1
    THEN GREATEST(first_available_event_id - 1, 0)
  ELSE 0
END
WHERE stream_name = 'installation';
