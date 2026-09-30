import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { createFactoryImagePreparer } from "./factory-image-preparation.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("shares one preparation and returns the pinned image to concurrent runs", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "kestrel-image-preparer-"));
  directories.push(stateRoot);
  const docker = join(stateRoot, "docker");
  const log = join(stateRoot, "docker.log");
  const imageId = `sha256:${"b".repeat(64)}`;
  await writeFile(join(stateRoot, "factory-execution-image"), `${imageId}\n`, { mode: 0o600 });
  await writeFile(
    docker,
    `#!/usr/bin/env node\nconst { appendFileSync } = require("node:fs");\nappendFileSync(${JSON.stringify(log)}, "inspect\\n");\nconsole.log(${JSON.stringify(`${imageId} 0.155.1`)});\n`,
  );
  await chmod(docker, 0o755);
  vi.stubEnv("KESTREL_STATE_ROOT", stateRoot);
  const prepare = createFactoryImagePreparer({
    dockerExecutable: docker,
    signal: new AbortController().signal,
  });
  await expect(Promise.all([prepare(), prepare()])).resolves.toEqual([imageId, imageId]);
  await expect(readFile(log, "utf8")).resolves.toBe("inspect\n");
});
