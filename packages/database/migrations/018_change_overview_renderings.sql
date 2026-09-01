CREATE TABLE change_overview_renderings (
  change_proposal_id uuid PRIMARY KEY REFERENCES change_proposals(id) ON DELETE CASCADE,
  review_revision_id uuid NOT NULL REFERENCES review_revisions(id) ON DELETE CASCADE,
  exact_head_object_id text NOT NULL CHECK (
    exact_head_object_id ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'
  ),
  generation_token uuid NOT NULL UNIQUE,
  rendering_state text NOT NULL CHECK (
    rendering_state IN ('queued', 'rendering', 'ready', 'unavailable')
  ),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  provider_request_id text CHECK (
    provider_request_id IS NULL OR provider_request_id ~ '^[A-Za-z0-9._:-]{1,128}$'
  ),
  sentences jsonb CHECK (
    sentences IS NULL OR (
      jsonb_typeof(sentences) = 'array'
      AND jsonb_array_length(sentences) BETWEEN 1 AND 4
      AND octet_length(sentences::text) <= 4096
    )
  ),
  failure_reason text CHECK (
    failure_reason IS NULL OR failure_reason IN (
      'credential_unavailable',
      'invalid_rendering',
      'model_unavailable',
      'profile_not_configured',
      'profile_unavailable',
      'timed_out'
    )
  ),
  queue_milliseconds bigint CHECK (
    queue_milliseconds IS NULL OR queue_milliseconds BETWEEN 0 AND 86400000
  ),
  model_milliseconds bigint CHECK (
    model_milliseconds IS NULL OR model_milliseconds BETWEEN 0 AND 120000
  ),
  kestrel_milliseconds bigint CHECK (
    kestrel_milliseconds IS NULL OR kestrel_milliseconds BETWEEN 0 AND 120000
  ),
  total_milliseconds bigint CHECK (
    total_milliseconds IS NULL OR total_milliseconds BETWEEN 0 AND 86640000
  ),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (started_at IS NULL OR started_at >= requested_at),
  CHECK (completed_at IS NULL OR (started_at IS NOT NULL AND completed_at >= started_at)),
  CHECK (
    total_milliseconds IS NULL OR total_milliseconds =
      queue_milliseconds + model_milliseconds + kestrel_milliseconds
  ),
  CHECK (
    (
      rendering_state = 'queued'
      AND started_at IS NULL
      AND completed_at IS NULL
      AND provider_request_id IS NULL
      AND sentences IS NULL
      AND failure_reason IS NULL
      AND queue_milliseconds IS NULL
      AND model_milliseconds IS NULL
      AND kestrel_milliseconds IS NULL
      AND total_milliseconds IS NULL
    )
    OR
    (
      rendering_state = 'rendering'
      AND started_at IS NOT NULL
      AND completed_at IS NULL
      AND provider_request_id IS NULL
      AND sentences IS NULL
      AND failure_reason IS NULL
      AND queue_milliseconds IS NULL
      AND model_milliseconds IS NULL
      AND kestrel_milliseconds IS NULL
      AND total_milliseconds IS NULL
    )
    OR
    (
      rendering_state = 'ready'
      AND started_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND provider_request_id IS NOT NULL
      AND sentences IS NOT NULL
      AND failure_reason IS NULL
      AND queue_milliseconds IS NOT NULL
      AND model_milliseconds IS NOT NULL
      AND kestrel_milliseconds IS NOT NULL
      AND total_milliseconds IS NOT NULL
    )
    OR
    (
      rendering_state = 'unavailable'
      AND started_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND provider_request_id IS NULL
      AND sentences IS NULL
      AND failure_reason IS NOT NULL
      AND queue_milliseconds IS NOT NULL
      AND model_milliseconds IS NOT NULL
      AND kestrel_milliseconds IS NOT NULL
      AND total_milliseconds IS NOT NULL
    )
  )
);

CREATE FUNCTION enforce_change_overview_rendering_fence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  canonical_proposal_id uuid;
  revision_head_object_id text;
BEGIN
  SELECT COALESCE(proposal.canonical_change_proposal_id, proposal.id),
         revision.head_object_id
  INTO canonical_proposal_id, revision_head_object_id
  FROM public.review_revisions AS revision
  INNER JOIN public.change_proposals AS proposal
    ON proposal.id = revision.change_proposal_id
  WHERE revision.id = NEW.review_revision_id
    AND revision.revision_state = 'available';

  IF canonical_proposal_id IS DISTINCT FROM NEW.change_proposal_id
     OR revision_head_object_id IS DISTINCT FROM NEW.exact_head_object_id THEN
    RAISE EXCEPTION 'Change Overview rendering must match one Available Proposal head'
      USING ERRCODE = '23514', CONSTRAINT = 'change_overview_renderings_revision_fence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER change_overview_renderings_revision_fence
BEFORE INSERT OR UPDATE OF change_proposal_id, review_revision_id, exact_head_object_id
ON change_overview_renderings
FOR EACH ROW
EXECUTE FUNCTION enforce_change_overview_rendering_fence();

CREATE INDEX change_overview_renderings_state_idx
ON change_overview_renderings (rendering_state, requested_at, change_proposal_id);

REVOKE ALL PRIVILEGES ON change_overview_renderings FROM kestrel_runtime;
GRANT SELECT, INSERT, UPDATE ON change_overview_renderings TO kestrel_runtime;

COMMENT ON TABLE change_overview_renderings IS
'Latest-only, Proposal/head-fenced natural-language orientation derived from bounded Change Overview facts.';
