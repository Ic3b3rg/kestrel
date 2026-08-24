import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { generatedArtifacts } from "../src/openapi.js";

const committedDirectory = fileURLToPath(new URL("../generated", import.meta.url));

async function writeArtifacts(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Promise.all(
    Object.entries(generatedArtifacts).map(([name, contents]) =>
      writeFile(join(directory, name), contents, "utf8"),
    ),
  );
}

async function checkArtifacts(): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "kestrel-contracts-"));

  try {
    await writeArtifacts(temporaryDirectory);
    for (const name of Object.keys(generatedArtifacts)) {
      const [expected, actual] = await Promise.all([
        readFile(join(temporaryDirectory, name), "utf8"),
        readFile(join(committedDirectory, name), "utf8"),
      ]);
      if (actual !== expected) {
        throw new Error(`Generated contract is stale: ${name}`);
      }
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true });
  }
}

if (process.argv.includes("--check")) {
  await checkArtifacts();
} else {
  await writeArtifacts(committedDirectory);
  process.stdout.write(`Generated contracts in ${committedDirectory}\n`);
}
