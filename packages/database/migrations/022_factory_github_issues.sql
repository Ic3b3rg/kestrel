CREATE TABLE factory_issue_import_requests (
  feature_id uuid NOT NULL REFERENCES factory_features(id),
  request_id uuid NOT NULL,
  issue_numbers jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (feature_id, request_id)
);

CREATE TABLE factory_issue_imports (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  feature_id uuid NOT NULL REFERENCES factory_features(id),
  repository_provider_id text NOT NULL,
  issue_provider_id text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (feature_id, repository_provider_id, issue_provider_id),
  UNIQUE (id, feature_id)
);
CREATE INDEX factory_issue_import_identity ON factory_issue_imports(repository_provider_id, issue_provider_id);

CREATE TABLE factory_feature_publications (
  feature_id uuid PRIMARY KEY REFERENCES factory_features(id),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'blocked', 'published')),
  identity jsonb,
  coordinates jsonb,
  feature_url text,
  failure text,
  job_id uuid NOT NULL DEFAULT uuidv7(),
  attempt_id uuid,
  started_at timestamptz,
  retry_after timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE factory_issue_publications (
  work_item_id uuid PRIMARY KEY,
  feature_id uuid NOT NULL,
  issue_operation_id uuid NOT NULL UNIQUE DEFAULT uuidv7(),
  issue_attempted boolean NOT NULL DEFAULT false,
  issue jsonb,
  comment_operation_id uuid NOT NULL UNIQUE DEFAULT uuidv7(),
  comment_attempted boolean NOT NULL DEFAULT false,
  comment_id text,
  dependency_mode text CHECK (dependency_mode IN ('native', 'textual')),
  failure text,
  published_at timestamptz,
  FOREIGN KEY (work_item_id, feature_id) REFERENCES factory_work_items(id, feature_id)
);

CREATE TABLE factory_provider_operations (
  id uuid PRIMARY KEY,
  work_item_id uuid NOT NULL REFERENCES factory_issue_publications(work_item_id),
  kind text NOT NULL CHECK (kind IN ('issue', 'comment')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (work_item_id, kind)
);

CREATE TABLE factory_provider_dependencies (
  work_item_id uuid NOT NULL REFERENCES factory_issue_publications(work_item_id),
  blocking_work_item_id uuid NOT NULL REFERENCES factory_issue_publications(work_item_id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'attempted', 'confirmed', 'textual')),
  PRIMARY KEY (work_item_id, blocking_work_item_id),
  CHECK (work_item_id <> blocking_work_item_id)
);

CREATE TABLE factory_publication_retry_requests (
  feature_id uuid NOT NULL REFERENCES factory_features(id),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (feature_id, request_id)
);

ALTER TABLE factory_activity DROP CONSTRAINT factory_activity_kind_check;
ALTER TABLE factory_activity ADD CONSTRAINT factory_activity_kind_check CHECK (kind IN (
  'draft_saved', 'plan_generated', 'plan_approved', 'item_queued', 'feature_cancelled',
  'issues_imported', 'issue_published', 'publication_failed', 'publication_retried'
));

-- Previously approved features enter the same durable publication outbox.
INSERT INTO factory_feature_publications (feature_id)
  SELECT id FROM factory_features WHERE approved_plan_version IS NOT NULL;
UPDATE factory_feature_publications publication SET coordinates = jsonb_build_object(
  'owner', source.github_owner_snapshot, 'name', source.github_name_snapshot)
FROM factory_features feature JOIN local_repository_sources source ON source.project_id = feature.project_id
WHERE publication.feature_id = feature.id AND source.attachment_state = 'attached'
  AND source.github_owner_snapshot IS NOT NULL AND source.github_name_snapshot IS NOT NULL;
INSERT INTO factory_issue_publications (work_item_id, feature_id)
  SELECT id, feature_id FROM factory_work_items;
INSERT INTO factory_provider_dependencies (work_item_id, blocking_work_item_id)
  SELECT item.id, blocker.id
  FROM factory_work_items item
  JOIN factory_plan_versions plan ON plan.feature_id = item.feature_id AND plan.version = item.plan_version
  CROSS JOIN LATERAL jsonb_array_elements(plan.document->'workItems') definition
  CROSS JOIN LATERAL jsonb_array_elements_text(definition->'dependsOn') dependency
  JOIN factory_work_items blocker ON blocker.feature_id = item.feature_id
    AND blocker.plan_version = item.plan_version AND blocker.key = dependency.value
  WHERE definition->>'key' = item.key;

GRANT SELECT, INSERT ON factory_issue_import_requests, factory_issue_imports,
  factory_provider_operations, factory_publication_retry_requests TO kestrel_runtime;
REVOKE UPDATE, DELETE ON factory_issue_import_requests, factory_issue_imports,
  factory_provider_operations, factory_publication_retry_requests FROM kestrel_runtime;
GRANT SELECT, INSERT, UPDATE ON factory_feature_publications, factory_issue_publications,
  factory_provider_dependencies TO kestrel_runtime;
REVOKE DELETE ON factory_feature_publications, factory_issue_publications,
  factory_provider_dependencies FROM kestrel_runtime;
