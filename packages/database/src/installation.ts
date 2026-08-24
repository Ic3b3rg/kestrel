import type { DatabasePool } from "./pool.js";

export type InstallationState =
  "ready" | "diagnostic_queued" | "diagnostic_running" | "diagnostic_succeeded";

export interface Installation {
  id: string;
  state: InstallationState;
  currentDiagnosticId: string | null;
  revision: string;
  createdAt: string;
  updatedAt: string;
}

export interface InstallationSnapshot {
  schemaVersion: 1;
  installation: Installation;
  diagnostic: null;
  eventCursor: "0";
}

interface InstallationDatabaseRow {
  id: string;
  state: InstallationState;
  current_diagnostic_id: string | null;
  revision: string;
  created_at: Date;
  updated_at: Date;
}

export async function readInstallationSnapshot(pool: DatabasePool): Promise<InstallationSnapshot> {
  const result = await pool.query<InstallationDatabaseRow>(`
    SELECT id, state, current_diagnostic_id, revision, created_at, updated_at
    FROM installations
  `);

  if (result.rowCount !== 1 || !result.rows[0]) {
    throw new Error(`Expected one Kestrel Installation, found ${String(result.rowCount ?? 0)}`);
  }

  const row = result.rows[0];
  return {
    schemaVersion: 1,
    installation: {
      id: row.id,
      state: row.state,
      currentDiagnosticId: row.current_diagnostic_id,
      revision: row.revision,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    },
    diagnostic: null,
    eventCursor: "0",
  };
}
