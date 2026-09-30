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
const VERSION = "0.155.1";
// Release asset digests from github.com/openai/codex/releases/tag/rust-v0.155.1.
const assets = {
  arm64: {
    name: "aarch64",
    digest: "d6c7e62fbd688d52ee04f3929d0613705d32a920a42db7a139e366eaf1f4a2d7",
  },
  x64: {
    name: "x86_64",
    digest: "a0ef8b2debc3bf747e07b1a039354de31300ac0dcc2276498ba281470b5d9115",
  },
};

export async function prepareFactoryExecutionImage(environment = process.env, signal) {
  signal?.throwIfAborted();
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
      {
        signal:
          signal === undefined
            ? AbortSignal.timeout(120_000)
            : AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      },
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
      signal,
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
      { env, signal, timeout: 300_000, maxBuffer: 2_000_000 },
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

export async function ensureFactoryExecutionImage(
  environment = process.env,
  prepare = prepareFactoryExecutionImage,
  signal,
) {
  signal?.throwIfAborted();
  const stateRoot = environment.KESTREL_STATE_ROOT ?? resolve(".kestrel/development");
  if (!isAbsolute(stateRoot)) throw new Error("KESTREL_STATE_ROOT must be absolute");
  try {
    const directory = await lstat(stateRoot);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (process.getuid !== undefined && directory.uid !== process.getuid())
    )
      throw new Error("KESTREL_STATE_ROOT must be an owned, non-symlink directory");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const docker = await resolveDocker(environment);
  const imageFile = join(stateRoot, "factory-execution-image");
  let pinned = null;
  try {
    const file = await lstat(imageFile);
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      (process.getuid !== undefined && file.uid !== process.getuid())
    )
      throw new Error("The Factory execution image file must be an owned regular file");
    pinned = (await readFile(imageFile, "utf8")).trim();
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (pinned !== null && /^sha256:[a-f0-9]{64}$/u.test(pinned)) {
    const existing = await exec(
      docker,
      [
        "image",
        "inspect",
        "--format",
        '{{.Id}} {{index .Config.Labels "org.opencontainers.image.version"}}',
        pinned,
      ],
      { env: environmentForDocker(docker, environment), signal, timeout: 30_000 },
    ).catch(() => null);
    if (existing?.stdout.trim() === `${pinned} ${VERSION}`) return { imageId: pinned, docker };
  }
  signal?.throwIfAborted();
  return prepare(environment, signal);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Factory image preparation stopped"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    console.log("Preparing the isolated Factory executor (Codex 0.155.1, Node 24, Git)…");
    const { imageId } = process.argv.includes("--ensure")
      ? await ensureFactoryExecutionImage(
          process.env,
          prepareFactoryExecutionImage,
          controller.signal,
        )
      : await prepareFactoryExecutionImage(process.env, controller.signal);
    console.log(`Factory executor ready: ${imageId}`);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
