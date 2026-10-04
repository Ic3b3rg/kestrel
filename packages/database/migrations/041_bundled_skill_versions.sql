-- Release-included versions keep planning authority after an explicit catalog update,
-- just as historical Operator installations do. Preview alone grants no authority.
CREATE TABLE factory_bundled_skill_versions (
  digest text PRIMARY KEY REFERENCES factory_planning_skill_versions(digest),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
GRANT SELECT, INSERT ON factory_bundled_skill_versions TO kestrel_runtime;
REVOKE UPDATE, DELETE ON factory_bundled_skill_versions FROM kestrel_runtime;
