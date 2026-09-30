import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { ensureFactoryExecutionImage } from "./factory-execution-image.mjs";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(imageAvailable: boolean, version = "0.155.1") {
  const stateRoot = await mkdtemp(join(tmpdir(), "kestrel-image-ensure-"));
  directories.push(stateRoot);
  const docker = join(stateRoot, "docker");
  const imageId = `sha256:${"a".repeat(64)}`;
  await writeFile(
    docker,
    `#!/usr/bin/env node\nif (process.argv.at(-1) !== "${imageId}" || ${String(!imageAvailable)}) process.exit(1);\nconsole.log("${imageId} ${version}");\n`,
  );
  await chmod(docker, 0o755);
  return { stateRoot, docker, imageId };
}

it("reuses a pinned image that still exists in Docker", async () => {
  const { stateRoot, docker, imageId } = await fixture(true);
  await writeFile(join(stateRoot, "factory-execution-image"), `${imageId}\n`, { mode: 0o600 });
  const prepare = vi.fn();
  await expect(
    ensureFactoryExecutionImage(
      { ...process.env, KESTREL_STATE_ROOT: stateRoot, DOCKER_BIN: docker },
      prepare,
    ),
  ).resolves.toEqual({ imageId, docker: await realpath(docker) });
  expect(prepare).not.toHaveBeenCalled();
});

it("prepares a missing image and re-prepares one absent from Docker", async () => {
  const { stateRoot, docker, imageId } = await fixture(false);
  const prepare = vi.fn(() => Promise.resolve({ imageId, docker }));
  const environment = { ...process.env, KESTREL_STATE_ROOT: stateRoot, DOCKER_BIN: docker };
  await expect(ensureFactoryExecutionImage(environment, prepare)).resolves.toEqual({
    imageId,
    docker,
  });
  await writeFile(join(stateRoot, "factory-execution-image"), `${imageId}\n`, { mode: 0o600 });
  await expect(ensureFactoryExecutionImage(environment, prepare)).resolves.toEqual({
    imageId,
    docker,
  });
  expect(prepare).toHaveBeenCalledTimes(2);
});

it("re-prepares a pinned image from an older Codex release", async () => {
  const { stateRoot, docker, imageId } = await fixture(true, "0.154.0");
  await writeFile(join(stateRoot, "factory-execution-image"), `${imageId}\n`, { mode: 0o600 });
  const prepare = vi.fn(() => Promise.resolve({ imageId, docker }));
  await expect(
    ensureFactoryExecutionImage(
      { ...process.env, KESTREL_STATE_ROOT: stateRoot, DOCKER_BIN: docker },
      prepare,
    ),
  ).resolves.toEqual({ imageId, docker });
  expect(prepare).toHaveBeenCalledTimes(1);
});
