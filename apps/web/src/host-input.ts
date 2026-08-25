import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";

export interface HostInputField {
  prompt: string;
  secret: boolean;
}

let muted = false;
const promptOutput = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    if (!muted) {
      stdout.write(chunk);
    }
    callback();
  },
});

async function readPipedInput(maximumBytes: number): Promise<string[]> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > maximumBytes) {
      throw new Error("Host command input is too large");
    }
    chunks.push(buffer);
  }
  const values = Buffer.concat(chunks).toString("utf8").split(/\r?\n/u);
  if (values.at(-1) === "") {
    values.pop();
  }
  return values;
}

async function readInteractiveInput(fields: readonly HostInputField[]): Promise<string[]> {
  const prompt = createInterface({ input: stdin, output: promptOutput, terminal: true });
  try {
    const values: string[] = [];
    for (const field of fields) {
      if (field.secret) {
        stdout.write(field.prompt);
        muted = true;
        values.push(await prompt.question(""));
        muted = false;
        stdout.write("\n");
      } else {
        values.push(await prompt.question(field.prompt));
      }
    }
    return values;
  } finally {
    muted = false;
    prompt.close();
  }
}

export async function readHostCommandInput(
  fields: readonly HostInputField[],
  maximumBytes = 1_024,
): Promise<string[]> {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 16_384) {
    throw new Error("Host command input limit is invalid");
  }
  const values =
    stdin.isTTY && stdout.isTTY
      ? await readInteractiveInput(fields)
      : await readPipedInput(maximumBytes);
  if (values.length !== fields.length) {
    throw new Error("Host command input is incomplete");
  }
  return values;
}
