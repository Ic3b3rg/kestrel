import { z } from "zod";

export const SchemaVersionSchema = z.literal(1);
export const EventCursorSchema = z
  .string()
  .max(19)
  .regex(/^(0|[1-9][0-9]*)$/u);
export const KestrelIdSchema = z.uuidv7();
export const CorrelationIdSchema = z.uuid();
export const UtcDateTimeSchema = z.iso.datetime({ offset: false });

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
    "PAYLOAD_TOO_LARGE",
    "UNSUPPORTED_MEDIA_TYPE",
    "REQUEST_REJECTED",
    "NOT_FOUND",
    "INSTALLATION_TRANSITION_CONFLICT",
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
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export type DiagnosticAccepted = z.infer<typeof DiagnosticAcceptedSchema>;
export type DiagnosticCommand = z.infer<typeof DiagnosticCommandSchema>;
export type EventCursor = z.infer<typeof EventCursorSchema>;
export type Installation = z.infer<typeof InstallationSchema>;
export type InstallationEvent = z.infer<typeof InstallationEventSchema>;
export type InstallationEventType = z.infer<typeof InstallationEventTypeSchema>;
export type InstallationSnapshot = z.infer<typeof InstallationSnapshotSchema>;
export type InstallationState = z.infer<typeof InstallationStateSchema>;
