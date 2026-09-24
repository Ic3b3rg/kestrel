ALTER TABLE factory_planning_messages ADD COLUMN attachment_fingerprint text;
CREATE TABLE factory_planning_attachments (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  feature_id uuid NOT NULL REFERENCES factory_features(id),
  message_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 3),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 0 AND 2097152),
  UNIQUE (message_id, position),
  FOREIGN KEY (message_id, feature_id) REFERENCES factory_planning_messages(id, feature_id)
);
CREATE INDEX factory_planning_attachments_feature ON factory_planning_attachments(feature_id);
GRANT SELECT, INSERT ON factory_planning_attachments TO kestrel_runtime;
