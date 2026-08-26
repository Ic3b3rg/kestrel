export type LocalSourceErrorCode =
  | "configuration_invalid"
  | "discovery_limit_exceeded"
  | "git_inspection_failed"
  | "object_missing"
  | "object_verification_failed"
  | "path_not_retained"
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
