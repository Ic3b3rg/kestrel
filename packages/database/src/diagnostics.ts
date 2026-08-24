import { randomUUID } from "node:crypto";

import {
  CorrelationIdSchema,
  DiagnosticAcceptedSchema,
  KestrelIdSchema,
  type Diagnostic,
  type DiagnosticAccepted,
  type InstallationEvent,
} from "@kestrel/contracts";
import type { PgBoss } from "pg-boss";

import { appendInstallationEvent } from "./events.js";
import { mapInstallationRow, type InstallationDatabaseRow } from "./installation.js";
import { DIAGNOSTIC_QUEUE, pgBossDatabase } from "./pg-boss.js";
import type { DatabasePool } from "./pool.js";

type DiagnosticStatus = Diagnostic["status"];
export type DiagnosticNextStatus = Exclude<DiagnosticStatus, "queued">;
export type DiagnosticTransitionDecision = "already_applied" | "apply" | "invalid";
export type DiagnosticJobSender = Pick<PgBoss, "send">;

export interface DiagnosticLogContext {
  correlationId: string;
  diagnosticId: string;
  installationId: string;
}

interface DiagnosticDatabaseRow {
  completed_at: Date | null;
  correlation_id: string;
  id: string;
  installation_id: string;
  requested_at: Date;
  started_at: Date | null;
  status: DiagnosticStatus;
}

export class InstallationTransitionConflictError extends Error {}

export function classifyDiagnosticTransition(
  current: DiagnosticStatus,
  next: DiagnosticNextStatus,
): DiagnosticTransitionDecision {
  if (current === next || current === "succeeded") {
    return "already_applied";
  }
  if (
    (current === "queued" && next === "running") ||
    (current === "running" && next === "succeeded")
  ) {
    return "apply";
  }
  return "invalid";
}

function mapDiagnostic(row: DiagnosticDatabaseRow): Diagnostic {
  return {
    id: row.id,
    status: row.status,
    requestedAt: row.requested_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

function eventTypeFor(status: DiagnosticStatus) {
  return `installation.diagnostic.${status}` as const;
}

export async function enqueueDiagnostic(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
  retentionLimit: number,
  correlationId: string = randomUUID(),
): Promise<DiagnosticAccepted> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const selected = await client.query<InstallationDatabaseRow>(`
      SELECT id, state, current_diagnostic_id, revision, created_at, updated_at
      FROM installations
      FOR UPDATE
    `);
    const installation = selected.rows[0];
    if (!installation || selected.rowCount !== 1) {
      throw new Error("Expected one Kestrel Installation");
    }
    if (installation.state === "diagnostic_queued" || installation.state === "diagnostic_running") {
      throw new InstallationTransitionConflictError("An Installation diagnostic is already active");
    }

    const insertedDiagnostic = await client.query<DiagnosticDatabaseRow>(
      `
        INSERT INTO diagnostics (installation_id, status, correlation_id)
        VALUES ($1, 'queued', $2)
        RETURNING id, installation_id, status, correlation_id,
                  requested_at, started_at, completed_at
      `,
      [installation.id, correlationId],
    );
    const diagnosticRow = insertedDiagnostic.rows[0];
    if (!diagnosticRow) {
      throw new Error("Diagnostic insert returned no row");
    }

    const updatedInstallation = await client.query<InstallationDatabaseRow>(
      `
        UPDATE installations
        SET state = 'diagnostic_queued',
            current_diagnostic_id = $1,
            revision = revision + 1,
            updated_at = clock_timestamp()
        WHERE id = $2
        RETURNING id, state, current_diagnostic_id, revision, created_at, updated_at
      `,
      [diagnosticRow.id, installation.id],
    );
    const installationRow = updatedInstallation.rows[0];
    if (!installationRow) {
      throw new Error("Installation diagnostic transition returned no row");
    }

    const event = await appendInstallationEvent(
      client,
      {
        aggregateId: installationRow.id,
        aggregateVersion: installationRow.revision,
        causationId: null,
        correlationId,
        diagnosticId: diagnosticRow.id,
        eventType: eventTypeFor("queued"),
      },
      retentionLimit,
    );
    const jobId = await boss.send(
      DIAGNOSTIC_QUEUE,
      { diagnosticId: diagnosticRow.id },
      { db: pgBossDatabase(client), id: diagnosticRow.id },
    );
    if (jobId !== diagnosticRow.id) {
      throw new Error("Diagnostic job was not enqueued with its durable identifier");
    }

    const accepted = DiagnosticAcceptedSchema.parse({
      schemaVersion: 1,
      installation: mapInstallationRow(installationRow),
      diagnostic: mapDiagnostic(diagnosticRow),
      eventCursor: event.eventId,
    });
    await client.query("COMMIT");
    return accepted;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function readDiagnosticLogContext(
  pool: DatabasePool,
  diagnosticId: string,
): Promise<DiagnosticLogContext> {
  const selected = await pool.query<
    Pick<DiagnosticDatabaseRow, "correlation_id" | "id" | "installation_id">
  >(
    `
      SELECT id, installation_id, correlation_id
      FROM diagnostics
      WHERE id = $1
    `,
    [diagnosticId],
  );
  const diagnostic = selected.rows[0];
  if (!diagnostic) {
    throw new Error(`Diagnostic does not exist: ${diagnosticId}`);
  }

  return {
    correlationId: CorrelationIdSchema.parse(diagnostic.correlation_id),
    diagnosticId: KestrelIdSchema.parse(diagnostic.id),
    installationId: KestrelIdSchema.parse(diagnostic.installation_id),
  };
}

export async function transitionDiagnostic(
  pool: DatabasePool,
  diagnosticId: string,
  nextStatus: DiagnosticNextStatus,
  retentionLimit: number,
): Promise<InstallationEvent | null> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const selected = await client.query<DiagnosticDatabaseRow>(
      `
        SELECT id, installation_id, status, correlation_id,
               requested_at, started_at, completed_at
        FROM diagnostics
        WHERE id = $1
        FOR UPDATE
      `,
      [diagnosticId],
    );
    const diagnostic = selected.rows[0];
    if (!diagnostic) {
      throw new Error(`Diagnostic does not exist: ${diagnosticId}`);
    }

    const decision = classifyDiagnosticTransition(diagnostic.status, nextStatus);
    if (decision === "already_applied") {
      await client.query("COMMIT");
      return null;
    }
    if (decision === "invalid") {
      throw new Error(`Invalid diagnostic transition: ${diagnostic.status} -> ${nextStatus}`);
    }

    const timestampAssignment =
      nextStatus === "running"
        ? "started_at = COALESCE(started_at, clock_timestamp())"
        : "completed_at = COALESCE(completed_at, clock_timestamp())";
    const updatedDiagnostic = await client.query(
      `
        UPDATE diagnostics
        SET status = $2, ${timestampAssignment}
        WHERE id = $1
      `,
      [diagnosticId, nextStatus],
    );
    if (updatedDiagnostic.rowCount !== 1) {
      throw new Error("Diagnostic transition did not update exactly one row");
    }

    const installationState = `diagnostic_${nextStatus}`;
    const updatedInstallation = await client.query<InstallationDatabaseRow>(
      `
        UPDATE installations
        SET state = $2,
            revision = revision + 1,
            updated_at = clock_timestamp()
        WHERE id = $1 AND current_diagnostic_id = $3
        RETURNING id, state, current_diagnostic_id, revision, created_at, updated_at
      `,
      [diagnostic.installation_id, installationState, diagnosticId],
    );
    const installation = updatedInstallation.rows[0];
    if (!installation) {
      throw new Error("Diagnostic no longer belongs to the current Installation operation");
    }

    const event = await appendInstallationEvent(
      client,
      {
        aggregateId: installation.id,
        aggregateVersion: installation.revision,
        causationId: diagnostic.correlation_id,
        correlationId: diagnostic.correlation_id,
        diagnosticId,
        eventType: eventTypeFor(nextStatus),
      },
      retentionLimit,
    );
    await client.query("COMMIT");
    return event;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
