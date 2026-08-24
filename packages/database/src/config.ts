import { z } from "zod";

const DatabaseConfigSchema = z.strictObject({
  DATABASE_URL: z
    .url()
    .refine((value) => value.startsWith("postgres://") || value.startsWith("postgresql://"), {
      message: "DATABASE_URL must use the postgres or postgresql scheme",
    }),
});

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
