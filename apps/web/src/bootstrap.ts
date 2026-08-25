import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";

import { OperatorUsernameSchema } from "@kestrel/contracts";
import { bootstrapOperator, createPool, readDatabaseConfig } from "@kestrel/database";
import { z } from "zod";

import { hashPassword } from "./password.js";

const BootstrapPasswordSchema = z.string().min(12).max(128);
const MAX_BOOTSTRAP_INPUT_BYTES = 1_024;

let muted = false;
const promptOutput = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    if (!muted) {
      stdout.write(chunk);
    }
    callback();
  },
});

interface BootstrapInput {
  confirmation: string;
  password: string;
  username: string;
}

async function readPipedInput(): Promise<BootstrapInput> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BOOTSTRAP_INPUT_BYTES) {
      throw new Error("Bootstrap input is too large");
    }
    chunks.push(buffer);
  }
  const values = Buffer.concat(chunks).toString("utf8").split(/\r?\n/u);
  if (values.at(-1) === "") {
    values.pop();
  }
  const [username, password, confirmation] = values;
  if (
    values.length !== 3 ||
    username === undefined ||
    password === undefined ||
    confirmation === undefined
  ) {
    throw new Error("Bootstrap input is incomplete");
  }
  return { confirmation, password, username };
}

async function readInteractiveInput(): Promise<BootstrapInput> {
  const prompt = createInterface({ input: stdin, output: promptOutput, terminal: true });
  try {
    const username = (await prompt.question("Username: ")).trim();
    stdout.write("Password: ");
    muted = true;
    const password = await prompt.question("");
    muted = false;
    stdout.write("\nConfirm password: ");
    muted = true;
    const confirmation = await prompt.question("");
    muted = false;
    stdout.write("\n");
    return { confirmation, password, username };
  } finally {
    muted = false;
    prompt.close();
  }
}

async function main(): Promise<void> {
  const input = stdin.isTTY && stdout.isTTY ? await readInteractiveInput() : await readPipedInput();
  const username = OperatorUsernameSchema.parse(input.username);
  const password = BootstrapPasswordSchema.parse(input.password);
  if (password !== input.confirmation) {
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
