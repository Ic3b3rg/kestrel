import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { environmentForDocker, resolveDocker } from "./host-executables.mjs";

const exec = promisify(execFile);
const VERSION = "0.153.4";
// Release asset digests from github.com/openai/codex/releases/tag/rust-v0.153.4.
const assets = {
  arm64: {
    name: "aarch64",
    digest: "5cda6182bd94c3a30f2eb63a495489ebf7f691fddb14d70f48c6c1a5071b6cde",
  },
  x64: {
    name: "x86_64",
    digest: "f479424eca092484dc40d87ae28c44f4cc40234a60045d6131e493800d814a30",
  },
};

export async function prepareFactoryExecutionImage(environment = process.env) {
  const asset = assets[process.arch];
  if (asset === undefined) throw new Error("The Factory executor supports arm64 and x64 hosts");
  const stateRoot = environment.KESTREL_STATE_ROOT ?? resolve(".kestrel/development");
  if (!isAbsolute(stateRoot)) throw new Error("KESTREL_STATE_ROOT must be absolute");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const directory = await lstat(stateRoot);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (process.getuid !== undefined && directory.uid !== process.getuid())
  )
    throw new Error("KESTREL_STATE_ROOT must be an owned, non-symlink directory");
  await chmod(stateRoot, 0o700);
  const docker = await resolveDocker(environment);
  const env = environmentForDocker(docker, environment);
  const staging = await mkdtemp(join(tmpdir(), "kestrel-executor-image-"));
  try {
    const file = `codex-${asset.name}-unknown-linux-musl`;
    const response = await fetch(
      `https://github.com/openai/codex/releases/download/rust-v${VERSION}/${file}.tar.gz`,
      { signal: AbortSignal.timeout(120_000) },
    );
    if (!response.ok || response.body === null)
      throw new Error("The official Codex executor download failed");
    const parts = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 256 * 1024 * 1024) throw new Error("The executor archive exceeds its size limit");
      parts.push(chunk);
    }
    const archive = Buffer.concat(parts);
    if (createHash("sha256").update(archive).digest("hex") !== asset.digest)
      throw new Error("The official Codex executor digest does not match");
    await writeFile(join(staging, "codex.tar.gz"), archive, { flag: "wx", mode: 0o600 });
    await exec("tar", ["-xzf", join(staging, "codex.tar.gz"), "-C", staging, file], {
      timeout: 30_000,
    });
    await rename(join(staging, file), join(staging, "codex"));
    await rm(join(staging, "codex.tar.gz"));
    await copyFile(
      new URL("../Dockerfile.execution", import.meta.url),
      join(staging, "Dockerfile"),
    );
    await exec(
      docker,
      [
        "build",
        "--iidfile",
        join(staging, "image-id"),
        "--tag",
        `kestrel-factory-executor:${VERSION}`,
        staging,
      ],
      { env, timeout: 300_000, maxBuffer: 2_000_000 },
    );
    const imageId = (await readFile(join(staging, "image-id"), "utf8")).trim();
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageId))
      throw new Error("Docker did not return an immutable executor image identity");
    const imageFile = join(stateRoot, `factory-execution-image-${randomUUID()}`);
    await writeFile(imageFile, `${imageId}\n`, { flag: "wx", mode: 0o600 });
    await rename(imageFile, join(stateRoot, "factory-execution-image"));
    return { imageId, docker };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log("Preparing the isolated Factory executor (Codex 0.153.4, Node 24, Git)…");
  const { imageId } = await prepareFactoryExecutionImage();
  console.log(`Factory executor ready: ${imageId}`);
}
