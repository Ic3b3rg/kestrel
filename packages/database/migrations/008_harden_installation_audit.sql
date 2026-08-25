DROP TRIGGER installation_audit_append_only ON installation_audit_records;

CREATE TRIGGER installation_audit_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON installation_audit_records
FOR EACH STATEMENT
EXECUTE FUNCTION reject_installation_audit_mutation();
