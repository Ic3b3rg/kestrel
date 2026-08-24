import { z } from "zod";

const DatabaseConfigSchema = z.strictObject({
  DATABASE_URL: z
    .url()
    .refine((value) => value.startsWith("postgres://") || value.startsWith("postgresql://"), {
      message: "DATABASE_URL must use the postgres or postgresql scheme",
    }),
});

const EventRetentionLimitSchema = z.coerce.number().int().min(1).max(100_000).default(1_000);

export interface DatabaseConfig {
  databaseUrl: string;
}

export function readDatabaseConfig(environment: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const result = DatabaseConfigSchema.safeParse({ DATABASE_URL: environment.DATABASE_URL });
  if (!result.success) {
    throw new Error(`Invalid database configuration: ${z.prettifyError(result.error)}`);
  }

  return { databaseUrl: result.data.DATABASE_URL };
}

export function readEventRetentionLimit(environment: NodeJS.ProcessEnv = process.env): number {
  const result = EventRetentionLimitSchema.safeParse(environment.EVENT_RETENTION_LIMIT);
  if (!result.success) {
    throw new Error(`Invalid event retention configuration: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
