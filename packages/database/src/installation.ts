import type {
  Diagnostic,
  Installation,
  InstallationSnapshot,
  InstallationState,
} from "@kestrel/contracts";

import type { DatabasePool } from "./pool.js";

export interface InstallationDatabaseRow {
  created_at: Date;
  current_diagnostic_id: string | null;
  id: string;
  revision: string;
  state: InstallationState;
  updated_at: Date;
}

interface InstallationSnapshotDatabaseRow extends InstallationDatabaseRow {
  diagnostic_completed_at: Date | null;
  diagnostic_id: string | null;
  diagnostic_requested_at: Date | null;
  diagnostic_started_at: Date | null;
  diagnostic_status: Diagnostic["status"] | null;
  event_cursor: string;
}

export function mapInstallationRow(row: InstallationDatabaseRow): Installation {
  return {
    id: row.id,
    state: row.state,
    currentDiagnosticId: row.current_diagnostic_id,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapCurrentDiagnostic(row: InstallationSnapshotDatabaseRow): Diagnostic | null {
  if (row.diagnostic_id === null) {
    return null;
  }
  if (row.diagnostic_status === null || row.diagnostic_requested_at === null) {
    throw new Error("Current Installation diagnostic is incomplete");
  }
  return {
    id: row.diagnostic_id,
    status: row.diagnostic_status,
    requestedAt: row.diagnostic_requested_at.toISOString(),
    startedAt: row.diagnostic_started_at?.toISOString() ?? null,
    completedAt: row.diagnostic_completed_at?.toISOString() ?? null,
  };
}

export async function readInstallationSnapshot(pool: DatabasePool): Promise<InstallationSnapshot> {
  const result = await pool.query<InstallationSnapshotDatabaseRow>(`
    SELECT i.id,
           i.state,
           i.current_diagnostic_id,
           i.revision,
           i.created_at,
           i.updated_at,
           d.id AS diagnostic_id,
           d.status AS diagnostic_status,
           d.requested_at AS diagnostic_requested_at,
           d.started_at AS diagnostic_started_at,
           d.completed_at AS diagnostic_completed_at,
           s.latest_event_id AS event_cursor
    FROM installations AS i
    LEFT JOIN diagnostics AS d ON d.id = i.current_diagnostic_id
    CROSS JOIN event_streams AS s
    WHERE s.stream_name = 'installation'
  `);

  if (result.rowCount !== 1 || !result.rows[0]) {
    throw new Error(`Expected one Kestrel Installation, found ${String(result.rowCount ?? 0)}`);
  }

  const row = result.rows[0];
  return {
    schemaVersion: 1,
    installation: mapInstallationRow(row),
    diagnostic: mapCurrentDiagnostic(row),
    eventCursor: row.event_cursor,
  };
}

export type { Installation, InstallationSnapshot, InstallationState } from "@kestrel/contracts";
