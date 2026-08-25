import { randomUUID } from "node:crypto";
import { stdout } from "node:process";

import { NewOperatorPasswordSchema } from "@kestrel/contracts";
import { createPool, readDatabaseConfig, resetOperatorPassword } from "@kestrel/database";

import { readHostCommandInput } from "./host-input.js";
import { hashPassword } from "./password.js";

async function main(): Promise<void> {
  const [rawPassword, confirmation] = await readHostCommandInput([
    { prompt: "New password: ", secret: true },
    { prompt: "Confirm new password: ", secret: true },
  ]);
  const password = NewOperatorPasswordSchema.parse(rawPassword);
  if (password !== confirmation) {
    throw new Error("Password confirmation does not match");
  }

  const passwordHash = await hashPassword(password);
  const config = readDatabaseConfig();
  const pool = createPool(config.databaseUrl, "kestrel-password-reset");
  try {
    await resetOperatorPassword(pool, {
      correlationId: randomUUID(),
      passwordHash,
    });
    stdout.write("Operator password reset. All sessions were invalidated.\n");
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch {
  stdout.write("Operator password reset failed.\n");
  process.exitCode = 1;
}
