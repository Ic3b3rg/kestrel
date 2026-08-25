import { stdout } from "node:process";

import { NewOperatorPasswordSchema, OperatorUsernameSchema } from "@kestrel/contracts";
import { bootstrapOperator, createPool, readDatabaseConfig } from "@kestrel/database";

import { readHostCommandInput } from "./host-input.js";
import { hashPassword } from "./password.js";

async function main(): Promise<void> {
  const [rawUsername, rawPassword, confirmation] = await readHostCommandInput([
    { prompt: "Username: ", secret: false },
    { prompt: "Password: ", secret: true },
    { prompt: "Confirm password: ", secret: true },
  ]);
  const username = OperatorUsernameSchema.parse(rawUsername?.trim());
  const password = NewOperatorPasswordSchema.parse(rawPassword);
  if (password !== confirmation) {
    throw new Error("Password confirmation does not match");
  }
  const passwordHash = await hashPassword(password);
  const config = readDatabaseConfig();
  const pool = createPool(config.databaseUrl, "kestrel-bootstrap");
  try {
    const result = await bootstrapOperator(pool, { passwordHash, username });
    stdout.write(result.created ? "Operator created.\n" : "Operator already exists.\n");
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch {
  stdout.write("Bootstrap failed.\n");
  process.exitCode = 1;
}
