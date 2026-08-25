ALTER TABLE operators
ADD COLUMN credential_version bigint NOT NULL DEFAULT 1 CHECK (credential_version > 0),
ADD COLUMN jwt_signing_generation bigint NOT NULL DEFAULT 1 CHECK (jwt_signing_generation > 0),
ADD COLUMN changed_at timestamptz NOT NULL DEFAULT clock_timestamp();
