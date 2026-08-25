import { z } from "zod";

export const SchemaVersionSchema = z.literal(1);
export const EventCursorSchema = z
  .string()
  .max(19)
  .regex(/^(0|[1-9][0-9]*)$/u);
export const CredentialVersionSchema = z
  .string()
  .max(18)
  .regex(/^[1-9][0-9]*$/u);
export const KestrelIdSchema = z.uuidv7();
export const CorrelationIdSchema = z.uuid();
export const UtcDateTimeSchema = z.iso.datetime({ offset: false });
export const OperatorUsernameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

const GitHubOwnerSchema = z
  .string()
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u);
const GitHubRepositoryNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/u);
const GitHubOpaqueIdSchema = z.string().min(1).max(256);
const GitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const GitReferenceSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);

export const PublicGitHubPullRequestUrlSchema = z
  .string()
  .max(256)
  .regex(
    /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}\/pull\/[1-9][0-9]{0,9}$/u,
  );

export const OpenPublicGitHubPullRequestCommandSchema = z.strictObject({
  url: PublicGitHubPullRequestUrlSchema,
});

export const RepositoryAccessSchema = z.strictObject({
  authentication: z.literal("none"),
  kind: z.literal("public_github"),
  synchronization: z.literal("manual"),
});

export const RepositorySnapshotSchema = z.strictObject({
  canonicalUrl: z
    .string()
    .max(240)
    .regex(
      /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/u,
    ),
  name: GitHubRepositoryNameSchema,
  owner: GitHubOwnerSchema,
  providerId: GitHubOpaqueIdSchema,
});

export const GitRevisionPointerSchema = z.strictObject({
  objectId: GitObjectIdSchema,
  ref: GitReferenceSchema,
});

export const ChangeProposalSchema = z.strictObject({
  id: KestrelIdSchema,
  providerId: GitHubOpaqueIdSchema,
  number: z.number().int().positive().max(9_999_999_999),
  title: z.string().min(1).max(512),
  canonicalUrl: PublicGitHubPullRequestUrlSchema,
  proposalState: z.enum(["open", "merged", "closed", "unknown"]),
  base: GitRevisionPointerSchema,
  head: GitRevisionPointerSchema,
  author: z
    .strictObject({
      login: z.string().min(1).max(100),
      providerId: GitHubOpaqueIdSchema,
    })
    .nullable(),
  observedAt: UtcDateTimeSchema,
});

export const ProjectSchema = z.strictObject({
  id: KestrelIdSchema,
  repositoryAccess: RepositoryAccessSchema,
  repository: RepositorySnapshotSchema,
  sourceAvailability: z.enum(["available", "unavailable"]),
  providerContext: z.enum(["public_pull_request", "not_applicable"]),
  modelAccess: z.enum(["not_configured"]),
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema,
  changeProposals: z.array(ChangeProposalSchema).max(100),
});

export const ProjectInboxSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  projects: z.array(ProjectSchema).max(100),
});

export const ProjectUpsertedSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  project: ProjectSchema,
});

export const OperatorSchema = z.strictObject({
  id: KestrelIdSchema,
  username: OperatorUsernameSchema,
});

export const LoginCommandSchema = z.strictObject({
  username: OperatorUsernameSchema,
  password: z.string().min(1).max(128),
});

export const NewOperatorPasswordSchema = z.string().min(12).max(128);

export const SessionSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  operator: OperatorSchema,
  credentialVersion: CredentialVersionSchema,
  issuedAt: UtcDateTimeSchema,
  expiresAt: UtcDateTimeSchema,
});

export const StepUpActionSchema = z.enum([
  "operator_credentials_change",
  "provider_connect",
  "provider_disconnect",
  "provider_replace",
  "model_credentials_change",
  "project_delete",
  "installation_update",
]);

export const RequestDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const StepUpProofTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export const StepUpCommandSchema = z.strictObject({
  action: StepUpActionSchema,
  password: z.string().min(1).max(128),
  requestDigest: RequestDigestSchema,
  targetId: KestrelIdSchema,
});

export const StepUpProofSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  expiresAt: UtcDateTimeSchema,
  proof: StepUpProofTokenSchema,
});

export const CredentialChangeCommandSchema = z.strictObject({
  expectedVersion: CredentialVersionSchema,
  newPassword: NewOperatorPasswordSchema,
  username: OperatorUsernameSchema,
});

export const LogoutCommandSchema = z.strictObject({});

export function serializeCredentialChangeCommand(command: CredentialChangeCommand): string {
  const validated = CredentialChangeCommandSchema.parse(command);
  return JSON.stringify({
    expectedVersion: validated.expectedVersion,
    newPassword: validated.newPassword,
    username: validated.username,
  });
}

export const InstallationStateSchema = z.enum([
  "ready",
  "diagnostic_queued",
  "diagnostic_running",
  "diagnostic_succeeded",
]);

export const DiagnosticStatusSchema = z.enum(["queued", "running", "succeeded"]);

export const InstallationSchema = z.strictObject({
  id: KestrelIdSchema,
  state: InstallationStateSchema,
  currentDiagnosticId: KestrelIdSchema.nullable(),
  revision: EventCursorSchema,
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema,
});

export const DiagnosticSchema = z.strictObject({
  id: KestrelIdSchema,
  status: DiagnosticStatusSchema,
  requestedAt: UtcDateTimeSchema,
  startedAt: UtcDateTimeSchema.nullable(),
  completedAt: UtcDateTimeSchema.nullable(),
});

export const InstallationSnapshotSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  installation: InstallationSchema,
  diagnostic: DiagnosticSchema.nullable(),
  eventCursor: EventCursorSchema,
});

export const DiagnosticCommandSchema = z.strictObject({});

export const DiagnosticAcceptedSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  installation: InstallationSchema,
  diagnostic: DiagnosticSchema,
  eventCursor: EventCursorSchema,
});

export const InstallationEventTypeSchema = z.enum([
  "installation.diagnostic.queued",
  "installation.diagnostic.running",
  "installation.diagnostic.succeeded",
]);

export const InstallationEventSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  eventId: EventCursorSchema,
  aggregateType: z.literal("installation"),
  aggregateId: KestrelIdSchema,
  aggregateVersion: EventCursorSchema,
  eventType: InstallationEventTypeSchema,
  occurredAt: UtcDateTimeSchema,
  correlationId: CorrelationIdSchema,
  causationId: CorrelationIdSchema.nullable(),
  locator: z.strictObject({
    installationId: KestrelIdSchema,
    diagnosticId: KestrelIdSchema,
  }),
});

const StandardApiErrorSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  code: z.enum([
    "INVALID_REQUEST",
    "AUTHENTICATION_FAILED",
    "AUTHENTICATION_REQUIRED",
    "RATE_LIMITED",
    "PAYLOAD_TOO_LARGE",
    "UNSUPPORTED_MEDIA_TYPE",
    "REQUEST_REJECTED",
    "NOT_FOUND",
    "INSTALLATION_TRANSITION_CONFLICT",
    "OPERATOR_VERSION_CONFLICT",
    "SERVICE_UNAVAILABLE",
    "INTERNAL_ERROR",
  ]),
  message: z.string().min(1),
  correlationId: CorrelationIdSchema,
});

const ExpiredCursorApiErrorSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  code: z.literal("EVENT_CURSOR_EXPIRED"),
  message: z.string().min(1),
  correlationId: CorrelationIdSchema,
  firstAvailableEventId: EventCursorSchema,
  refetch: z.literal("/api/v1/installation"),
});

export const ApiErrorSchema = z.discriminatedUnion("code", [
  StandardApiErrorSchema,
  ExpiredCursorApiErrorSchema,
]);

export const HealthStatusSchema = z.strictObject({
  status: z.enum(["live", "ready"]),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type CredentialChangeCommand = z.infer<typeof CredentialChangeCommandSchema>;
export type CredentialVersion = z.infer<typeof CredentialVersionSchema>;
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export type DiagnosticAccepted = z.infer<typeof DiagnosticAcceptedSchema>;
export type DiagnosticCommand = z.infer<typeof DiagnosticCommandSchema>;
export type EventCursor = z.infer<typeof EventCursorSchema>;
export type Installation = z.infer<typeof InstallationSchema>;
export type InstallationEvent = z.infer<typeof InstallationEventSchema>;
export type InstallationEventType = z.infer<typeof InstallationEventTypeSchema>;
export type InstallationSnapshot = z.infer<typeof InstallationSnapshotSchema>;
export type InstallationState = z.infer<typeof InstallationStateSchema>;
export type LoginCommand = z.infer<typeof LoginCommandSchema>;
export type OpenPublicGitHubPullRequestCommand = z.infer<
  typeof OpenPublicGitHubPullRequestCommandSchema
>;
export type NewOperatorPassword = z.infer<typeof NewOperatorPasswordSchema>;
export type LogoutCommand = z.infer<typeof LogoutCommandSchema>;
export type Operator = z.infer<typeof OperatorSchema>;
export type OperatorUsername = z.infer<typeof OperatorUsernameSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectInbox = z.infer<typeof ProjectInboxSchema>;
export type ProjectUpserted = z.infer<typeof ProjectUpsertedSchema>;
export type PublicGitHubPullRequestUrl = z.infer<typeof PublicGitHubPullRequestUrlSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type StepUpAction = z.infer<typeof StepUpActionSchema>;
export type StepUpCommand = z.infer<typeof StepUpCommandSchema>;
export type StepUpProof = z.infer<typeof StepUpProofSchema>;
export type StepUpProofToken = z.infer<typeof StepUpProofTokenSchema>;
