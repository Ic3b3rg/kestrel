import {
  EventCursorSchema,
  InstallationEventSchema,
  type InstallationEvent,
  type InstallationEventType,
} from "@kestrel/contracts";
import type { PoolClient } from "pg";

interface InstallationEventRow {
  aggregate_id: string;
  aggregate_version: string;
  causation_id: string | null;
  correlation_id: string;
  created_at: Date;
  event_type: InstallationEventType;
  id: string;
  payload: unknown;
  schema_version: number;
}

interface EventStreamMetadataRow {
  first_available_event_id: string;
  latest_event_id: string;
  retention_floor_event_id: string;
}

type EventQueryClient = Pick<PoolClient, "query">;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

interface EventReplayDatabaseRow {
  aggregate_id: string | null;
  aggregate_version: string | null;
  causation_id: string | null;
  correlation_id: string | null;
  created_at: Date | null;
  event_type: InstallationEventType | null;
  first_available_event_id: string;
  id: string | null;
  latest_event_id: string;
  payload: unknown;
  retention_floor_event_id: string;
  schema_version: number | null;
}

export class InvalidEventCursorError extends Error {}

export type EventCursorValidation = { valid: true } | { firstAvailable: string; valid: false };
export type EventReplayBatch =
  { events: InstallationEvent[]; valid: true } | { firstAvailable: string; valid: false };

export interface AppendInstallationEventInput {
  aggregateId: string;
  aggregateVersion: string;
  causationId: string | null;
  correlationId: string;
  diagnosticId: string;
  eventType: InstallationEventType;
}

function assertRetentionLimit(retentionLimit: number): void {
  if (!Number.isInteger(retentionLimit) || retentionLimit < 1 || retentionLimit > 100_000) {
    throw new Error("Event retention limit must be an integer between 1 and 100000");
  }
}

export function parseEventCursor(value: unknown): string {
  const parsed = EventCursorSchema.safeParse(value);
  if (!parsed.success || BigInt(parsed.data) > MAX_POSTGRES_BIGINT) {
    throw new InvalidEventCursorError("Event cursor must be a canonical PostgreSQL bigint string");
  }
  return parsed.data;
}

export function mapInstallationEvent(row: InstallationEventRow): InstallationEvent {
  return InstallationEventSchema.parse({
    schemaVersion: row.schema_version,
    eventId: row.id,
    aggregateType: "installation",
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    eventType: row.event_type,
    occurredAt: row.created_at.toISOString(),
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    locator: row.payload,
  });
}

function validateCursorAgainstMetadata(
  canonicalCursor: string,
  metadata: EventStreamMetadataRow,
): EventCursorValidation {
  const numericCursor = BigInt(canonicalCursor);
  const latest = BigInt(metadata.latest_event_id);
  if (numericCursor > latest) {
    throw new InvalidEventCursorError("Event cursor is newer than the committed stream");
  }

  if (numericCursor < BigInt(metadata.retention_floor_event_id)) {
    return { firstAvailable: metadata.first_available_event_id, valid: false };
  }
  return { valid: true };
}

async function readEventStreamMetadata(
  database: EventQueryClient,
): Promise<EventStreamMetadataRow> {
  const result = await database.query<EventStreamMetadataRow>(`
    SELECT first_available_event_id, latest_event_id, retention_floor_event_id
    FROM event_streams
    WHERE stream_name = 'installation'
  `);
  const metadata = result.rows[0];
  if (result.rowCount !== 1 || !metadata) {
    throw new Error("Installation event stream metadata is missing");
  }
  return metadata;
}

export async function validateCursor(
  database: EventQueryClient,
  cursor: string,
): Promise<EventCursorValidation> {
  const canonicalCursor = parseEventCursor(cursor);
  const metadata = await readEventStreamMetadata(database);
  return validateCursorAgainstMetadata(canonicalCursor, metadata);
}

function mapEventReplayRow(row: EventReplayDatabaseRow): InstallationEvent | null {
  if (row.id === null) {
    return null;
  }
  if (
    row.aggregate_id === null ||
    row.aggregate_version === null ||
    row.correlation_id === null ||
    row.created_at === null ||
    row.event_type === null ||
    row.schema_version === null
  ) {
    throw new Error(`Installation event ${row.id} is incomplete`);
  }
  return mapInstallationEvent({
    aggregate_id: row.aggregate_id,
    aggregate_version: row.aggregate_version,
    causation_id: row.causation_id,
    correlation_id: row.correlation_id,
    created_at: row.created_at,
    event_type: row.event_type,
    id: row.id,
    payload: row.payload,
    schema_version: row.schema_version,
  });
}

export async function readEventReplayBatch(
  database: EventQueryClient,
  cursor: string,
  limit: number,
): Promise<EventReplayBatch> {
  const canonicalCursor = parseEventCursor(cursor);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Event read limit must be an integer between 1 and 1000");
  }
  const result = await database.query<EventReplayDatabaseRow>(
    `
      SELECT stream.first_available_event_id,
             stream.latest_event_id,
             stream.retention_floor_event_id,
             event.id,
             event.schema_version,
             event.event_type,
             event.aggregate_id,
             event.aggregate_version,
             event.correlation_id,
             event.causation_id,
             event.payload,
             event.created_at
      FROM event_streams AS stream
      LEFT JOIN LATERAL (
        SELECT id, schema_version, event_type, aggregate_id, aggregate_version,
               correlation_id, causation_id, payload, created_at
        FROM installation_events
        WHERE id > $1
        ORDER BY id ASC
        LIMIT $2
      ) AS event ON true
      WHERE stream.stream_name = 'installation'
      ORDER BY event.id ASC NULLS LAST
    `,
    [canonicalCursor, limit],
  );
  const firstRow = result.rows[0];
  if (!firstRow) {
    throw new Error("Installation event stream metadata is missing");
  }
  const validation = validateCursorAgainstMetadata(canonicalCursor, firstRow);
  if (!validation.valid) {
    return validation;
  }
  const events = result.rows
    .map(mapEventReplayRow)
    .filter((event): event is InstallationEvent => event !== null);
  return { events, valid: true };
}

export async function appendInstallationEvent(
  client: PoolClient,
  input: AppendInstallationEventInput,
  retentionLimit: number,
): Promise<InstallationEvent> {
  assertRetentionLimit(retentionLimit);
  const inserted = await client.query<InstallationEventRow>(
    `
      INSERT INTO installation_events (
        schema_version,
        event_type,
        aggregate_id,
        aggregate_version,
        correlation_id,
        causation_id,
        payload
      )
      VALUES (1, $1, $2, $3, $4, $5, $6::jsonb)
      RETURNING id, schema_version, event_type, aggregate_id, aggregate_version,
                correlation_id, causation_id, payload, created_at
    `,
    [
      input.eventType,
      input.aggregateId,
      input.aggregateVersion,
      input.correlationId,
      input.causationId,
      JSON.stringify({
        diagnosticId: input.diagnosticId,
        installationId: input.aggregateId,
      }),
    ],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new Error("Installation event insert returned no row");
  }

  const pruned = await client.query<{ last_pruned_event_id: string | null }>(
    `
      WITH deleted AS (
        DELETE FROM installation_events
        WHERE id < (
          SELECT MIN(retained.id)
          FROM (
            SELECT id
            FROM installation_events
            ORDER BY id DESC
            LIMIT $1
          ) AS retained
        )
        RETURNING id
      )
      SELECT MAX(id) AS last_pruned_event_id
      FROM deleted
    `,
    [retentionLimit],
  );
  const lastPrunedEventId = pruned.rows[0]?.last_pruned_event_id ?? null;
  const updatedStream = await client.query(
    `
      UPDATE event_streams
      SET latest_event_id = $1,
          retention_floor_event_id = GREATEST(
            retention_floor_event_id,
            COALESCE($2::bigint, retention_floor_event_id)
          ),
          first_available_event_id = COALESCE(
            (SELECT MIN(id) FROM installation_events),
            $1::bigint + 1
          ),
          updated_at = clock_timestamp()
      WHERE stream_name = 'installation'
    `,
    [row.id, lastPrunedEventId],
  );
  if (updatedStream.rowCount !== 1) {
    throw new Error("Installation event stream metadata is missing");
  }
  await client.query("SELECT pg_notify('kestrel_events', $1)", [row.id]);

  return mapInstallationEvent(row);
}
