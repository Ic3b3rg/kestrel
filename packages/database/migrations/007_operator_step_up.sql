CREATE TABLE operator_step_up_proofs (
  proof_digest text PRIMARY KEY CHECK (proof_digest ~ '^[a-f0-9]{64}$'),
  operator_id uuid NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN (
    'operator_credentials_change',
    'provider_connect',
    'provider_disconnect',
    'provider_replace',
    'model_credentials_change',
    'project_delete',
    'installation_update'
  )),
  target_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  credential_version bigint NOT NULL CHECK (credential_version > 0),
  jwt_signing_generation bigint NOT NULL CHECK (jwt_signing_generation > 0),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  issued_correlation_id uuid NOT NULL,
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '5 minutes'),
  CHECK (consumed_at IS NULL OR consumed_at >= issued_at)
);

CREATE INDEX operator_step_up_active_idx
ON operator_step_up_proofs (operator_id, expires_at)
WHERE consumed_at IS NULL;
