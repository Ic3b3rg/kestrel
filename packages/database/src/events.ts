import {
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

function mapInstallationEvent(row: InstallationEventRow): InstallationEvent {
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
