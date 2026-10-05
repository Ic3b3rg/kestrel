import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureFactoryExecutionImage } from "./factory-execution-image.mjs";
import { environmentForDocker } from "./host-executables.mjs";

const exec = promisify(execFile);
const abort = new AbortController();
const stop = () => abort.abort();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
const { imageId: base, docker } = await ensureFactoryExecutionImage(
  process.env,
  undefined,
  abort.signal,
);
const files = [
  "Dockerfile.execution-node-docker",
  "scripts/factory-project-entrypoint.sh",
  "scripts/factory-project-preparation.mjs",
];
const digest = createHash("sha256").update(base);
for (const path of files) digest.update(await readFile(new URL(`../${path}`, import.meta.url)));
const tag = `kestrel-factory-node-docker:${digest.digest("hex").slice(0, 24)}`;
const env = environmentForDocker(docker, process.env);
// Dockerfile FROM requires a named reference, not a local image configuration ID.
// Give the verified local object a content-derived reference and recheck its identity.
const baseReference = `kestrel-factory-prepared-base:${base.slice(7)}`;
await exec(docker, ["tag", base, baseReference], { env, signal: abort.signal });
let imageId = (
  await exec(docker, ["image", "inspect", "--format", "{{.Id}}", tag], {
    env,
    signal: abort.signal,
  }).catch(() => null)
)?.stdout.trim();
if (imageId === undefined) {
  const staging = await mkdtemp(join(tmpdir(), "kestrel-project-image-"));
  try {
    await mkdir(join(staging, "scripts"));
    for (const path of files)
      await copyFile(
        new URL(`../${path}`, import.meta.url),
        join(staging, path === files[0] ? "Dockerfile" : path),
      );
    await exec(
      docker,
      [
        "build",
        "--build-arg",
        `EXECUTOR_IMAGE=${baseReference}`,
        "--iidfile",
        join(staging, "image-id"),
        "--tag",
        tag,
        staging,
      ],
      { env, signal: abort.signal, timeout: 600_000, maxBuffer: 2_000_000 },
    );
    imageId = (await readFile(join(staging, "image-id"), "utf8")).trim();
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) throw new Error("Invalid prepared image identity");
if (
  (
    await exec(docker, ["image", "inspect", "--format", "{{.Id}}", baseReference], {
      env,
      signal: abort.signal,
    })
  ).stdout.trim() !== base
)
  throw new Error("Prepared image base changed during construction");
console.log(`Factory project executor ready: ${imageId}`);
