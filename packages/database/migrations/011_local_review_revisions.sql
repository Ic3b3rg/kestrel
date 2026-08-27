ALTER TABLE projects
ALTER COLUMN provider_observation_kind DROP NOT NULL,
ALTER COLUMN provider DROP NOT NULL,
ALTER COLUMN provider_repository_id DROP NOT NULL,
ALTER COLUMN repository_owner_snapshot DROP NOT NULL,
ALTER COLUMN repository_name_snapshot DROP NOT NULL,
ALTER COLUMN repository_canonical_url_snapshot DROP NOT NULL;

ALTER TABLE projects
ADD COLUMN source_availability text NOT NULL DEFAULT 'not_acquired' CHECK (
  source_availability IN ('not_acquired', 'available', 'unavailable')
),
ADD CONSTRAINT projects_provider_identity_complete CHECK (
  (
    provider_observation_kind IS NULL
    AND provider IS NULL
    AND provider_repository_id IS NULL
    AND repository_owner_snapshot IS NULL
    AND repository_name_snapshot IS NULL
    AND repository_canonical_url_snapshot IS NULL
  )
  OR
  (
    provider_observation_kind = 'public_github'
    AND provider = 'github'
    AND provider_repository_id IS NOT NULL
    AND repository_owner_snapshot IS NOT NULL
    AND repository_name_snapshot IS NOT NULL
    AND repository_canonical_url_snapshot IS NOT NULL
  )
);

ALTER TABLE projects
ADD CONSTRAINT projects_id_installation_unique UNIQUE (id, installation_id),
ADD COLUMN canonical_project_id uuid,
ADD CONSTRAINT projects_canonical_project_foreign_key
  FOREIGN KEY (canonical_project_id, installation_id)
  REFERENCES projects (id, installation_id) ON DELETE RESTRICT,
ADD CONSTRAINT projects_canonical_project_distinct CHECK (
  canonical_project_id IS NULL OR canonical_project_id <> id
),
ADD CONSTRAINT projects_alias_has_no_provider CHECK (
  canonical_project_id IS NULL OR provider IS NULL
);

CREATE FUNCTION enforce_installation_project_capacity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM installations WHERE id = NEW.installation_id FOR UPDATE;
  IF (
    SELECT count(*) >= 100
    FROM projects
    WHERE installation_id = NEW.installation_id
      AND canonical_project_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Installation Project capacity exceeded'
      USING ERRCODE = '23514', CONSTRAINT = 'projects_installation_capacity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER projects_installation_capacity
BEFORE INSERT ON projects
FOR EACH ROW
EXECUTE FUNCTION enforce_installation_project_capacity();

CREATE FUNCTION lock_project_alias_families()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  old_family_id uuid;
  new_family_id uuid;
BEGIN
  new_family_id := COALESCE(NEW.canonical_project_id, NEW.id);
  IF TG_OP = 'UPDATE' THEN
    old_family_id := COALESCE(OLD.canonical_project_id, OLD.id);
  END IF;

  PERFORM project.id
  FROM public.projects AS project
  WHERE project.id = old_family_id
     OR project.id = new_family_id
  ORDER BY project.id
  FOR UPDATE;
  RETURN NEW;
END;
$$;

CREATE TRIGGER projects_review_domain_insert_family_lock
BEFORE INSERT ON projects
FOR EACH ROW
EXECUTE FUNCTION lock_project_alias_families();

CREATE TRIGGER projects_review_domain_update_family_lock
BEFORE UPDATE OF canonical_project_id ON projects
FOR EACH ROW
EXECUTE FUNCTION lock_project_alias_families();

ALTER TABLE change_proposals
ADD COLUMN proposal_kind text NOT NULL DEFAULT 'provider_observed' CHECK (
  proposal_kind IN ('provider_observed', 'local', 'alias')
);

ALTER TABLE change_proposals
ADD COLUMN canonical_change_proposal_id uuid REFERENCES change_proposals(id) ON DELETE RESTRICT,
ADD CONSTRAINT change_proposals_canonical_distinct CHECK (
  canonical_change_proposal_id IS NULL OR canonical_change_proposal_id <> id
),
ADD CONSTRAINT change_proposals_alias_identity CHECK (
  (proposal_kind = 'alias') = (canonical_change_proposal_id IS NOT NULL)
);

ALTER TABLE change_proposals
ALTER COLUMN provider_proposal_id DROP NOT NULL,
ALTER COLUMN provider_number DROP NOT NULL,
ALTER COLUMN canonical_url_snapshot DROP NOT NULL,
ALTER COLUMN proposal_state DROP NOT NULL,
ALTER COLUMN observed_at DROP NOT NULL;

ALTER TABLE change_proposals
DROP CONSTRAINT change_proposals_base_object_id_check,
DROP CONSTRAINT change_proposals_head_object_id_check;

ALTER TABLE change_proposals
ADD CONSTRAINT change_proposals_base_object_id_check CHECK (
  base_object_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'
),
ADD CONSTRAINT change_proposals_head_object_id_check CHECK (
  head_object_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'
),
ADD CONSTRAINT change_proposals_object_format_matches CHECK (
  char_length(base_object_id) = char_length(head_object_id)
),
ADD CONSTRAINT change_proposals_provider_identity_complete CHECK (
  (
    proposal_kind IN ('provider_observed', 'alias')
    AND provider_proposal_id IS NOT NULL
    AND provider_number IS NOT NULL
    AND canonical_url_snapshot IS NOT NULL
    AND proposal_state IS NOT NULL
    AND observed_at IS NOT NULL
  )
  OR
  (
    proposal_kind IN ('local', 'alias')
    AND provider_proposal_id IS NULL
    AND provider_number IS NULL
    AND canonical_url_snapshot IS NULL
    AND proposal_state IS NULL
    AND observed_at IS NULL
    AND author_provider_id IS NULL
    AND author_login_snapshot IS NULL
  )
);

CREATE UNIQUE INDEX change_proposals_local_exact_idx
ON change_proposals (project_id, base_object_id, head_object_id)
WHERE proposal_kind = 'local';

ALTER TABLE change_proposals
DROP CONSTRAINT change_proposals_project_id_provider_proposal_id_key,
DROP CONSTRAINT change_proposals_project_id_provider_number_key;

CREATE UNIQUE INDEX change_proposals_provider_id_idx
ON change_proposals (project_id, provider_proposal_id)
WHERE proposal_kind = 'provider_observed';

CREATE UNIQUE INDEX change_proposals_provider_number_idx
ON change_proposals (project_id, provider_number)
WHERE proposal_kind = 'provider_observed';

ALTER TABLE change_proposals
ADD CONSTRAINT change_proposals_id_project_unique UNIQUE (id, project_id);

CREATE FUNCTION enforce_project_change_proposal_capacity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM projects WHERE id = NEW.project_id FOR UPDATE;
  IF (
    SELECT count(*) >= 100
    FROM change_proposals
    WHERE project_id = NEW.project_id
      AND canonical_change_proposal_id IS NULL
      AND id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'Project Change Proposal capacity exceeded'
      USING ERRCODE = '23514', CONSTRAINT = 'change_proposals_project_capacity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER change_proposals_project_capacity
BEFORE INSERT OR UPDATE OF project_id ON change_proposals
FOR EACH ROW
EXECUTE FUNCTION enforce_project_change_proposal_capacity();

CREATE FUNCTION lock_change_proposal_alias_families()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  old_canonical_proposal_id uuid;
  old_project_id uuid;
  old_project_family_id uuid;
  new_project_family_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_project_id := OLD.project_id;
  END IF;

  PERFORM project.id
  FROM public.projects AS project
  WHERE project.id = old_project_id
     OR project.id = NEW.project_id
  ORDER BY project.id
  FOR UPDATE;

  SELECT COALESCE(project.canonical_project_id, project.id)
  INTO new_project_family_id
  FROM public.projects AS project
  WHERE project.id = NEW.project_id;

  IF TG_OP = 'UPDATE' THEN
    old_canonical_proposal_id := OLD.canonical_change_proposal_id;
    SELECT COALESCE(project.canonical_project_id, project.id)
    INTO old_project_family_id
    FROM public.projects AS project
    WHERE project.id = OLD.project_id;
  END IF;

  PERFORM project.id
  FROM public.projects AS project
  WHERE project.id = old_project_family_id
     OR project.id = new_project_family_id
  ORDER BY project.id
  FOR UPDATE;

  PERFORM proposal.id
  FROM public.change_proposals AS proposal
  WHERE proposal.id = NEW.id
     OR proposal.id = old_canonical_proposal_id
     OR proposal.id = NEW.canonical_change_proposal_id
  ORDER BY proposal.id
  FOR UPDATE;
  RETURN NEW;
END;
$$;

CREATE TRIGGER change_proposals_review_domain_insert_family_lock
BEFORE INSERT ON change_proposals
FOR EACH ROW
EXECUTE FUNCTION lock_change_proposal_alias_families();

CREATE TRIGGER change_proposals_review_domain_update_family_lock
BEFORE UPDATE OF project_id, canonical_change_proposal_id ON change_proposals
FOR EACH ROW
EXECUTE FUNCTION lock_change_proposal_alias_families();

CREATE TABLE local_repository_sources (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_identity text NOT NULL CHECK (source_identity ~ '^[a-f0-9]{64}$'),
  repository_id uuid NOT NULL,
  root_id uuid NOT NULL,
  repository_relative_locator text NOT NULL CHECK (
    octet_length(repository_relative_locator) BETWEEN 0 AND 4096
    AND repository_relative_locator !~ '(^|/)\.\.?(/|$)'
    AND repository_relative_locator !~ '^/'
  ),
  display_name_snapshot text NOT NULL CHECK (char_length(display_name_snapshot) BETWEEN 1 AND 256),
  object_format text NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
  github_owner_snapshot text CHECK (
    github_owner_snapshot IS NULL OR char_length(github_owner_snapshot) BETWEEN 1 AND 39
  ),
  github_name_snapshot text CHECK (
    github_name_snapshot IS NULL OR char_length(github_name_snapshot) BETWEEN 1 AND 100
  ),
  attachment_state text NOT NULL CHECK (attachment_state IN ('attached', 'detached')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((github_owner_snapshot IS NULL) = (github_name_snapshot IS NULL)),
  UNIQUE (installation_id, source_identity),
  UNIQUE (id, project_id)
);

CREATE UNIQUE INDEX local_repository_sources_current_project_idx
ON local_repository_sources (project_id)
WHERE attachment_state = 'attached';

CREATE FUNCTION lock_local_source_project_family()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  old_project_id uuid;
  old_family_id uuid;
  new_family_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_project_id := OLD.project_id;
  END IF;

  PERFORM project.id
  FROM public.projects AS project
  WHERE project.id = old_project_id
     OR project.id = NEW.project_id
  ORDER BY project.id
  FOR UPDATE;

  SELECT COALESCE(project.canonical_project_id, project.id)
  INTO new_family_id
  FROM public.projects AS project
  WHERE project.id = NEW.project_id;

  IF TG_OP = 'UPDATE' THEN
    SELECT COALESCE(project.canonical_project_id, project.id)
    INTO old_family_id
    FROM public.projects AS project
    WHERE project.id = OLD.project_id;
  END IF;

  PERFORM canonical.id
  FROM public.projects AS canonical
  WHERE canonical.id = new_family_id
     OR canonical.id = old_family_id
  ORDER BY canonical.id
  FOR UPDATE;
  RETURN NEW;
END;
$$;

CREATE TRIGGER local_sources_insert_project_family_lock
BEFORE INSERT ON local_repository_sources
FOR EACH ROW
EXECUTE FUNCTION lock_local_source_project_family();

CREATE TRIGGER local_sources_update_project_family_lock
BEFORE UPDATE OF project_id, attachment_state ON local_repository_sources
FOR EACH ROW
EXECUTE FUNCTION lock_local_source_project_family();

CREATE TABLE change_intents (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  change_proposal_id uuid NOT NULL REFERENCES change_proposals(id) ON DELETE CASCADE,
  version bigint NOT NULL CHECK (version > 0),
  intent_text text NOT NULL CHECK (
    char_length(btrim(intent_text)) BETWEEN 1 AND 20000
    AND octet_length(btrim(intent_text)) BETWEEN 1 AND 20000
  ),
  submitted_by_operator_id uuid NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (change_proposal_id, version),
  UNIQUE (id, change_proposal_id)
);

CREATE FUNCTION reject_change_intent_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Change Intent records are append-only';
END;
$$;

CREATE TRIGGER change_intents_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON change_intents
FOR EACH STATEMENT
EXECUTE FUNCTION reject_change_intent_mutation();

CREATE TABLE review_revisions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  change_proposal_id uuid NOT NULL REFERENCES change_proposals(id) ON DELETE CASCADE,
  local_repository_source_id uuid NOT NULL REFERENCES local_repository_sources(id) ON DELETE RESTRICT,
  acquisition_change_intent_id uuid NOT NULL REFERENCES change_intents(id) ON DELETE RESTRICT,
  revision_state text NOT NULL CHECK (
    revision_state IN ('acquiring', 'available', 'unavailable')
  ),
  base_ref_snapshot text NOT NULL CHECK (char_length(base_ref_snapshot) BETWEEN 1 AND 255),
  base_object_id text NOT NULL,
  head_ref_snapshot text NOT NULL CHECK (char_length(head_ref_snapshot) BETWEEN 1 AND 255),
  head_object_id text NOT NULL,
  object_format text NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
  max_bytes bigint NOT NULL CHECK (max_bytes > 0),
  max_objects bigint NOT NULL CHECK (max_objects > 0),
  object_count bigint CHECK (object_count IS NULL OR object_count > 0),
  retained_bytes bigint CHECK (retained_bytes IS NULL OR retained_bytes >= 0),
  artifact_locator text CHECK (
    artifact_locator IS NULL
    OR (
      artifact_locator ~ '^projects/[0-9a-f-]{36}/revisions/[0-9a-f-]{36}$'
      AND artifact_locator = 'projects/' || project_id::text || '/revisions/' || id::text
    )
  ),
  manifest_digest text CHECK (
    manifest_digest IS NULL OR manifest_digest ~ '^[a-f0-9]{64}$'
  ),
  failure_reason text CHECK (
    failure_reason IS NULL OR failure_reason IN (
      'source_not_available',
      'source_containment_violation',
      'reference_not_available',
      'revision_limit_exceeded',
      'object_missing',
      'object_verification_failed',
      'artifact_finalization_failed',
      'acquisition_interrupted'
    )
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  available_at timestamptz,
  CHECK (
    (object_format = 'sha1' AND base_object_id ~ '^[a-f0-9]{40}$' AND head_object_id ~ '^[a-f0-9]{40}$')
    OR
    (object_format = 'sha256' AND base_object_id ~ '^[a-f0-9]{64}$' AND head_object_id ~ '^[a-f0-9]{64}$')
  ),
  CHECK (
    (
      revision_state = 'acquiring'
      AND object_count IS NULL
      AND retained_bytes IS NULL
      AND artifact_locator IS NULL
      AND manifest_digest IS NULL
      AND failure_reason IS NULL
      AND available_at IS NULL
    )
    OR
    (
      revision_state = 'available'
      AND object_count IS NOT NULL
      AND retained_bytes IS NOT NULL
      AND artifact_locator IS NOT NULL
      AND manifest_digest IS NOT NULL
      AND failure_reason IS NULL
      AND available_at IS NOT NULL
    )
    OR
    (
      revision_state = 'unavailable'
      AND object_count IS NULL
      AND retained_bytes IS NULL
      AND artifact_locator IS NULL
      AND manifest_digest IS NULL
      AND failure_reason IS NOT NULL
      AND available_at IS NULL
    )
  ),
  UNIQUE (
    project_id,
    change_proposal_id,
    local_repository_source_id,
    base_object_id,
    head_object_id
  ),
  FOREIGN KEY (change_proposal_id, project_id)
    REFERENCES change_proposals (id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (acquisition_change_intent_id, change_proposal_id)
    REFERENCES change_intents (id, change_proposal_id) ON DELETE RESTRICT
);

CREATE FUNCTION enforce_review_revision_project_family()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  revision_canonical_project_id uuid;
  source_project_id uuid;
  source_canonical_project_id uuid;
BEGIN
  SELECT source.project_id
  INTO source_project_id
  FROM public.local_repository_sources AS source
  WHERE source.id = NEW.local_repository_source_id
  FOR UPDATE;

  PERFORM project.id
  FROM public.projects AS project
  WHERE project.id = NEW.project_id
     OR project.id = source_project_id
  ORDER BY project.id
  FOR UPDATE;

  SELECT COALESCE(project.canonical_project_id, project.id)
  INTO revision_canonical_project_id
  FROM public.projects AS project
  WHERE project.id = NEW.project_id;

  IF revision_canonical_project_id IS DISTINCT FROM NEW.project_id THEN
    RAISE EXCEPTION 'Review Revision Project must be canonical'
      USING ERRCODE = '23514', CONSTRAINT = 'review_revisions_canonical_project';
  END IF;

  SELECT COALESCE(source_project.canonical_project_id, source_project.id)
  INTO source_canonical_project_id
  FROM public.projects AS source_project
  WHERE source_project.id = source_project_id;

  PERFORM project.id
  FROM public.projects AS project
  WHERE project.id = revision_canonical_project_id
     OR project.id = source_canonical_project_id
  ORDER BY project.id
  FOR UPDATE;

  IF source_canonical_project_id IS DISTINCT FROM NEW.project_id THEN
    RAISE EXCEPTION 'Review Revision source belongs to another Project family'
      USING ERRCODE = '23514', CONSTRAINT = 'review_revisions_source_project_family';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER review_revisions_project_family
BEFORE INSERT ON review_revisions
FOR EACH ROW
EXECUTE FUNCTION enforce_review_revision_project_family();

CREATE FUNCTION reject_referenced_local_source_project_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.project_id IS DISTINCT FROM NEW.project_id
     AND EXISTS (
       SELECT 1
       FROM review_revisions
       WHERE local_repository_source_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'A referenced Local Repository Source cannot change Project'
      USING ERRCODE = '23514', CONSTRAINT = 'local_sources_referenced_project_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER local_sources_referenced_project_immutable
BEFORE UPDATE OF project_id ON local_repository_sources
FOR EACH ROW
EXECUTE FUNCTION reject_referenced_local_source_project_change();

CREATE FUNCTION enforce_review_domain_alias_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM projects AS alias_project
    INNER JOIN projects AS canonical_project
      ON canonical_project.id = alias_project.canonical_project_id
    WHERE canonical_project.canonical_project_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Project aliases must point directly to a canonical Project'
      USING ERRCODE = '23514', CONSTRAINT = 'projects_direct_canonical_alias';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM change_proposals AS alias_proposal
    INNER JOIN change_proposals AS canonical_proposal
      ON canonical_proposal.id = alias_proposal.canonical_change_proposal_id
    INNER JOIN projects AS alias_project ON alias_project.id = alias_proposal.project_id
    INNER JOIN projects AS canonical_project ON canonical_project.id = canonical_proposal.project_id
    WHERE canonical_proposal.canonical_change_proposal_id IS NOT NULL
       OR COALESCE(alias_project.canonical_project_id, alias_project.id)
          <> COALESCE(canonical_project.canonical_project_id, canonical_project.id)
  ) THEN
    RAISE EXCEPTION 'Change Proposal aliases must stay in one canonical Project family'
      USING ERRCODE = '23514', CONSTRAINT = 'change_proposals_canonical_family';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM review_revisions AS revision
    INNER JOIN projects AS revision_project ON revision_project.id = revision.project_id
    INNER JOIN local_repository_sources AS source
      ON source.id = revision.local_repository_source_id
    INNER JOIN projects AS source_project ON source_project.id = source.project_id
    WHERE COALESCE(revision_project.canonical_project_id, revision_project.id)
          <> COALESCE(source_project.canonical_project_id, source_project.id)
  ) THEN
    RAISE EXCEPTION 'Review Revision source left its canonical Project family'
      USING ERRCODE = '23514', CONSTRAINT = 'review_revisions_source_project_family';
  END IF;

  IF EXISTS (
    SELECT COALESCE(source_project.canonical_project_id, source_project.id)
    FROM local_repository_sources AS source
    INNER JOIN projects AS source_project ON source_project.id = source.project_id
    WHERE source.attachment_state = 'attached'
    GROUP BY COALESCE(source_project.canonical_project_id, source_project.id)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'A canonical Project family can have only one attached source'
      USING ERRCODE = '23514', CONSTRAINT = 'local_sources_current_project_family';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER projects_review_domain_alias_integrity
AFTER UPDATE OF canonical_project_id ON projects
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_review_domain_alias_integrity();

CREATE CONSTRAINT TRIGGER projects_insert_review_domain_alias_integrity
AFTER INSERT ON projects
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_review_domain_alias_integrity();

CREATE CONSTRAINT TRIGGER change_proposals_review_domain_alias_integrity
AFTER UPDATE OF project_id, canonical_change_proposal_id ON change_proposals
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_review_domain_alias_integrity();

CREATE CONSTRAINT TRIGGER change_proposals_insert_review_domain_alias_integrity
AFTER INSERT ON change_proposals
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_review_domain_alias_integrity();

CREATE CONSTRAINT TRIGGER local_sources_review_domain_alias_integrity
AFTER UPDATE OF project_id, attachment_state ON local_repository_sources
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_review_domain_alias_integrity();

CREATE CONSTRAINT TRIGGER local_sources_insert_review_domain_alias_integrity
AFTER INSERT ON local_repository_sources
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_review_domain_alias_integrity();

CREATE CONSTRAINT TRIGGER review_revisions_insert_review_domain_alias_integrity
AFTER INSERT ON review_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_review_domain_alias_integrity();

CREATE FUNCTION enforce_review_revision_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.revision_state = 'available' THEN
    RAISE EXCEPTION 'Available Review Revision records are immutable';
  END IF;

  IF (
    OLD.project_id,
    OLD.change_proposal_id,
    OLD.local_repository_source_id,
    OLD.base_ref_snapshot,
    OLD.base_object_id,
    OLD.head_ref_snapshot,
    OLD.head_object_id,
    OLD.object_format,
    OLD.max_bytes,
    OLD.max_objects
  ) IS DISTINCT FROM (
    NEW.project_id,
    NEW.change_proposal_id,
    NEW.local_repository_source_id,
    NEW.base_ref_snapshot,
    NEW.base_object_id,
    NEW.head_ref_snapshot,
    NEW.head_object_id,
    NEW.object_format,
    NEW.max_bytes,
    NEW.max_objects
  ) THEN
    RAISE EXCEPTION 'Review Revision identity is immutable';
  END IF;

  IF OLD.revision_state <> 'unavailable'
     AND OLD.acquisition_change_intent_id IS DISTINCT FROM NEW.acquisition_change_intent_id THEN
    RAISE EXCEPTION 'Review Revision acquisition intent is immutable outside retry';
  END IF;

  IF OLD.revision_state = 'acquiring' AND NEW.revision_state NOT IN ('available', 'unavailable') THEN
    RAISE EXCEPTION 'Invalid Review Revision state transition';
  END IF;
  IF OLD.revision_state = 'unavailable' AND NEW.revision_state <> 'acquiring' THEN
    RAISE EXCEPTION 'Invalid Review Revision retry transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER review_revisions_controlled_transition
BEFORE UPDATE ON review_revisions
FOR EACH ROW
EXECUTE FUNCTION enforce_review_revision_transition();

CREATE FUNCTION reject_review_revision_deletion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Review Revision records cannot be deleted or truncated';
END;
$$;

CREATE TRIGGER review_revisions_no_delete
BEFORE DELETE OR TRUNCATE ON review_revisions
FOR EACH STATEMENT
EXECUTE FUNCTION reject_review_revision_deletion();

REVOKE ALL PRIVILEGES
ON projects, change_proposals, local_repository_sources, change_intents, review_revisions
FROM kestrel_runtime;

GRANT SELECT, INSERT, UPDATE
ON projects, change_proposals, local_repository_sources, review_revisions
TO kestrel_runtime;

GRANT SELECT, INSERT
ON change_intents
TO kestrel_runtime;

CREATE INDEX review_revisions_project_created_idx
ON review_revisions (project_id, created_at DESC, id);

COMMENT ON TABLE local_repository_sources IS
'Operator-authorized read-only Git source locator kept separate from retained Review Revisions.';

COMMENT ON TABLE change_intents IS
'Append-only Operator-authored intent versions for one Change Proposal.';

COMMENT ON TABLE review_revisions IS
'Immutable exact commit pair and verified project-scoped artifact lifecycle.';
