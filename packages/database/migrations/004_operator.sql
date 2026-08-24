CREATE TABLE operators (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  username text NOT NULL CHECK (
    char_length(username) BETWEEN 1 AND 64
    AND username ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
  ),
  password_hash text NOT NULL CHECK (
    char_length(password_hash) BETWEEN 80 AND 512
    AND password_hash LIKE '$argon2id$v=19$%'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX operators_singleton ON operators ((true));
