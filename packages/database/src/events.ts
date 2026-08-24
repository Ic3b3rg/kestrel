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
}

interface EventStreamMetadataRow {
  first_available_event_id: string;
  latest_event_id: string;
}

type EventQueryClient = Pick<PoolClient, "query">;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

export class InvalidEventCursorError extends Error {}

export type EventCursorValidation = { valid: true } | { firstAvailable: string; valid: false };

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
    schemaVersion: 1,
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

async function readEventStreamMetadata(
  database: EventQueryClient,
): Promise<EventStreamMetadataRow> {
  const result = await database.query<EventStreamMetadataRow>(`
    SELECT first_available_event_id, latest_event_id
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
  const numericCursor = BigInt(canonicalCursor);
  const latest = BigInt(metadata.latest_event_id);
  if (numericCursor > latest) {
    throw new InvalidEventCursorError("Event cursor is newer than the committed stream");
  }

  const earliestReplayableCursor = BigInt(metadata.first_available_event_id) - 1n;
  if (numericCursor < earliestReplayableCursor) {
    return { firstAvailable: metadata.first_available_event_id, valid: false };
  }
  return { valid: true };
}

export async function readEventsAfter(
  database: EventQueryClient,
  cursor: string,
  limit: number,
): Promise<InstallationEvent[]> {
  const canonicalCursor = parseEventCursor(cursor);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Event read limit must be an integer between 1 and 1000");
  }
  const result = await database.query<InstallationEventRow>(
    `
      SELECT id, event_type, aggregate_id, aggregate_version,
             correlation_id, causation_id, payload, created_at
      FROM installation_events
      WHERE id > $1
      ORDER BY id ASC
      LIMIT $2
    `,
    [canonicalCursor, limit],
  );
  return result.rows.map(mapInstallationEvent);
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
        event_type,
        aggregate_id,
        aggregate_version,
        correlation_id,
        causation_id,
        payload
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      RETURNING id, event_type, aggregate_id, aggregate_version,
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

  await client.query(
    `
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
    `,
    [retentionLimit],
  );
  const updatedStream = await client.query(
    `
      UPDATE event_streams
      SET latest_event_id = $1,
          first_available_event_id = COALESCE(
            (SELECT MIN(id) FROM installation_events),
            $1::bigint + 1
          ),
          updated_at = clock_timestamp()
      WHERE stream_name = 'installation'
    `,
    [row.id],
  );
  if (updatedStream.rowCount !== 1) {
    throw new Error("Installation event stream metadata is missing");
  }
  await client.query("SELECT pg_notify('kestrel_events', $1)", [row.id]);

  return mapInstallationEvent(row);
}
