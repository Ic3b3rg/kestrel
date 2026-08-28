export type LocalSourceErrorCode =
  | "acquisition_cancelled"
  | "base_revision_unresolvable"
  | "configuration_invalid"
  | "discovery_limit_exceeded"
  | "git_inspection_failed"
  | "head_revision_unresolvable"
  | "object_missing"
  | "object_verification_failed"
  | "path_not_retained"
  | "pull_ref_mismatch"
  | "provider_authentication_required"
  | "provider_resource_unavailable"
  | "reference_limit_exceeded"
  | "reference_not_available"
  | "repository_invalid"
  | "repository_not_available"
  | "revision_limit_exceeded"
  | "source_containment_violation";

export class LocalSourceError extends Error {
  constructor(public readonly code: LocalSourceErrorCode) {
    super(`Local source operation failed: ${code}`);
    this.name = "LocalSourceError";
  }
}
