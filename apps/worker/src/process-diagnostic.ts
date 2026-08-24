import { KestrelIdSchema } from "@kestrel/contracts";
import { transitionDiagnostic, type DatabasePool } from "@kestrel/database";
import { z } from "zod";

const DiagnosticJobDataSchema = z.strictObject({
  diagnosticId: KestrelIdSchema,
});

export async function processDiagnostic(
  pool: DatabasePool,
  data: unknown,
  retentionLimit: number,
  signal: AbortSignal,
): Promise<void> {
  const { diagnosticId } = DiagnosticJobDataSchema.parse(data);
  signal.throwIfAborted();
  await transitionDiagnostic(pool, diagnosticId, "running", retentionLimit);
  signal.throwIfAborted();
  await transitionDiagnostic(pool, diagnosticId, "succeeded", retentionLimit);
}
