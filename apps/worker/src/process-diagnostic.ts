import { KestrelIdSchema } from "@kestrel/contracts";
import { transitionDiagnostic, type DatabasePool } from "@kestrel/database";
import { z } from "zod";

const DiagnosticJobDataSchema = z.strictObject({
  diagnosticId: KestrelIdSchema,
});

export type DiagnosticJobData = z.infer<typeof DiagnosticJobDataSchema>;

export function parseDiagnosticJobData(data: unknown): DiagnosticJobData {
  return DiagnosticJobDataSchema.parse(data);
}

export async function processDiagnostic(
  pool: DatabasePool,
  data: DiagnosticJobData,
  retentionLimit: number,
  signal: AbortSignal,
): Promise<void> {
  const { diagnosticId } = data;
  signal.throwIfAborted();
  await transitionDiagnostic(pool, diagnosticId, "running", retentionLimit);
  signal.throwIfAborted();
  await transitionDiagnostic(pool, diagnosticId, "succeeded", retentionLimit);
}
