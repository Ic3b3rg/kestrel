ALTER TABLE review_revisions
DROP CONSTRAINT review_revisions_failure_reason_check;

ALTER TABLE review_revisions
ADD CONSTRAINT review_revisions_failure_reason_check CHECK (
  failure_reason IS NULL OR failure_reason IN (
    'source_not_available',
    'source_containment_violation',
    'reference_not_available',
    'base_revision_unresolvable',
    'head_revision_unresolvable',
    'pull_ref_mismatch',
    'provider_authentication_required',
    'provider_resource_unavailable',
    'revision_limit_exceeded',
    'object_missing',
    'object_verification_failed',
    'artifact_finalization_failed',
    'acquisition_interrupted'
  )
);
