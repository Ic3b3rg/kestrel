ALTER TABLE change_proposals
ADD COLUMN optimistic_version bigint NOT NULL DEFAULT 1 CHECK (optimistic_version > 0);

ALTER TABLE review_revisions
ADD COLUMN base_commit_author_snapshot text CHECK (
  base_commit_author_snapshot IS NULL
  OR char_length(base_commit_author_snapshot) BETWEEN 1 AND 256
),
ADD COLUMN base_commit_subject_snapshot text CHECK (
  base_commit_subject_snapshot IS NULL
  OR char_length(base_commit_subject_snapshot) BETWEEN 1 AND 512
),
ADD COLUMN head_commit_author_snapshot text CHECK (
  head_commit_author_snapshot IS NULL
  OR char_length(head_commit_author_snapshot) BETWEEN 1 AND 256
),
ADD COLUMN head_commit_subject_snapshot text CHECK (
  head_commit_subject_snapshot IS NULL
  OR char_length(head_commit_subject_snapshot) BETWEEN 1 AND 512
);

DROP TRIGGER change_intents_append_only ON change_intents;

ALTER TABLE change_intents
ADD COLUMN objective text,
ADD COLUMN scope_boundaries jsonb,
ADD COLUMN acceptance_outcomes jsonb,
ADD COLUMN selected_sources jsonb,
ADD COLUMN source_digest text,
ADD COLUMN resolution_state text,
ADD COLUMN resolution_issues jsonb;

UPDATE change_intents
SET objective = btrim(intent_text),
    scope_boundaries = '[]'::jsonb,
    acceptance_outcomes = '[]'::jsonb,
    selected_sources = jsonb_build_array(
      jsonb_build_object(
        'id', 'operator_input',
        'kind', 'operator_input',
        'label', 'Operator input',
        'text', btrim(intent_text),
        'version', version::text,
        'provenance', jsonb_build_object('kind', 'operator_input')
      )
    ),
    resolution_state = 'unresolved',
    resolution_issues = jsonb_build_array(
      jsonb_build_object('kind', 'missing', 'field', 'scope_boundaries'),
      jsonb_build_object('kind', 'missing', 'field', 'acceptance_outcomes')
    );

UPDATE change_intents
SET source_digest = encode(
  sha256(convert_to(selected_sources::text, 'UTF8')),
  'hex'
);

ALTER TABLE change_intents
ALTER COLUMN scope_boundaries SET NOT NULL,
ALTER COLUMN acceptance_outcomes SET NOT NULL,
ALTER COLUMN selected_sources SET NOT NULL,
ALTER COLUMN source_digest SET NOT NULL,
ALTER COLUMN resolution_state SET NOT NULL,
ALTER COLUMN resolution_issues SET NOT NULL,
ADD CONSTRAINT change_intents_objective_check CHECK (
  objective IS NULL
  OR (
    char_length(btrim(objective)) BETWEEN 1 AND 20000
    AND octet_length(btrim(objective)) BETWEEN 1 AND 20000
  )
),
ADD CONSTRAINT change_intents_scope_boundaries_check CHECK (
  jsonb_typeof(scope_boundaries) = 'array'
  AND jsonb_array_length(scope_boundaries) <= 20
),
ADD CONSTRAINT change_intents_acceptance_outcomes_check CHECK (
  jsonb_typeof(acceptance_outcomes) = 'array'
  AND jsonb_array_length(acceptance_outcomes) <= 50
),
ADD CONSTRAINT change_intents_selected_sources_check CHECK (
  jsonb_typeof(selected_sources) = 'array'
  AND jsonb_array_length(selected_sources) <= 20
),
ADD CONSTRAINT change_intents_source_digest_check CHECK (source_digest ~ '^[a-f0-9]{64}$'),
ADD CONSTRAINT change_intents_resolution_state_check CHECK (
  resolution_state IN ('unresolved', 'resolved')
),
ADD CONSTRAINT change_intents_resolution_issues_check CHECK (
  jsonb_typeof(resolution_issues) = 'array'
  AND jsonb_array_length(resolution_issues) <= 24
),
ADD CONSTRAINT change_intents_resolved_shape_check CHECK (
  resolution_state <> 'resolved'
  OR (
    objective IS NOT NULL
    AND jsonb_array_length(scope_boundaries) > 0
    AND jsonb_array_length(acceptance_outcomes) > 0
    AND jsonb_array_length(selected_sources) > 0
    AND jsonb_array_length(resolution_issues) = 0
  )
),
ADD CONSTRAINT change_intents_unresolved_shape_check CHECK (
  resolution_state <> 'unresolved' OR jsonb_array_length(resolution_issues) > 0
);

CREATE TRIGGER change_intents_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON change_intents
FOR EACH STATEMENT
EXECUTE FUNCTION reject_change_intent_mutation();

COMMENT ON COLUMN change_proposals.optimistic_version IS
'Optimistic concurrency token advanced by every mutable Change Proposal update.';

COMMENT ON COLUMN change_intents.selected_sources IS
'Immutable server-authored source snapshots selected for this Change Intent version.';

COMMENT ON COLUMN change_intents.source_digest IS
'SHA-256 digest of the canonical selected-source snapshot sequence.';
