DELETE FROM operator_step_up_proofs;

DROP INDEX operator_step_up_active_idx;

ALTER TABLE operator_step_up_proofs
RENAME COLUMN request_digest TO request_binding_hmac;

ALTER TABLE operator_step_up_proofs
DROP COLUMN consumed_at;

CREATE INDEX operator_step_up_active_idx
ON operator_step_up_proofs (operator_id, expires_at);

COMMENT ON COLUMN operator_step_up_proofs.request_binding_hmac IS
'Server-keyed, domain-separated binding; never a client request digest';

CREATE INDEX authentication_rate_limits_window_started_idx
ON authentication_rate_limits (window_started_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kestrel_runtime') THEN
    CREATE ROLE kestrel_runtime
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public, pgboss TO kestrel_runtime;
REVOKE CREATE ON SCHEMA public, pgboss FROM kestrel_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE
ON ALL TABLES IN SCHEMA public, pgboss
TO kestrel_runtime;

GRANT USAGE, SELECT
ON ALL SEQUENCES IN SCHEMA public, pgboss
TO kestrel_runtime;

GRANT EXECUTE
ON ALL FUNCTIONS IN SCHEMA public, pgboss
TO kestrel_runtime;

ALTER DEFAULT PRIVILEGES IN SCHEMA public, pgboss
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kestrel_runtime;

ALTER DEFAULT PRIVILEGES IN SCHEMA public, pgboss
GRANT USAGE, SELECT ON SEQUENCES TO kestrel_runtime;

ALTER DEFAULT PRIVILEGES IN SCHEMA public, pgboss
GRANT EXECUTE ON FUNCTIONS TO kestrel_runtime;

REVOKE ALL PRIVILEGES
ON TABLE installation_audit_records
FROM kestrel_runtime;

GRANT SELECT, INSERT
ON TABLE installation_audit_records
TO kestrel_runtime;

REVOKE INSERT, UPDATE, DELETE
ON TABLE schema_migrations
FROM kestrel_runtime;
