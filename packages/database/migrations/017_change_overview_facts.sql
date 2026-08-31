CREATE TABLE change_overview_fact_manifests (
  review_revision_id uuid PRIMARY KEY REFERENCES review_revisions(id) ON DELETE CASCADE,
  rule_version smallint NOT NULL CHECK (rule_version = 1),
  source_facts jsonb NOT NULL CHECK (
    jsonb_typeof(source_facts) = 'object'
    AND source_facts ->> 'ruleVersion' = rule_version::text
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL PRIVILEGES
ON change_overview_fact_manifests
FROM kestrel_runtime;

GRANT SELECT, INSERT
ON change_overview_fact_manifests
TO kestrel_runtime;

COMMENT ON TABLE change_overview_fact_manifests IS
'Versioned deterministic facts derived only from one verified retained Review Revision.';
