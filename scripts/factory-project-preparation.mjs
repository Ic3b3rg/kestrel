// Runs only in the installation-authorized trusted Project execution container.
// Toolchain failures stop execution. Source builds are warm-ups, not acceptance checks.
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, copyFile, readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir("/workspace");
const warmupFailures = [];
async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}
async function command(program, args, { warmup = false } = {}) {
  console.log(`Preparing environment: ${program} ${args.join(" ")}`);
  const child = spawn(program, args, { stdio: "inherit", shell: false });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve(true);
      else if (warmup && signal === null && code !== null) {
        warmupFailures.push(`${program} (exit ${code})`);
        console.warn(
          `Project warm-up failed: ${program} (exit ${code}). Required verification still applies.`,
        );
        resolve(false);
      } else reject(new Error(`Environment preparation failed: ${program} (${signal ?? code})`));
    });
  });
}
if (!(await exists("package-lock.json")))
  throw new Error("The prepared Node environment requires a committed npm lockfile");
const lock = createHash("sha256")
  .update(await readFile("package-lock.json"))
  .update(await readFile("package.json"))
  .update(`${process.version}:${process.arch}:${process.platform}`)
  .digest("hex");
const stamp = "node_modules/.kestrel-environment-v1";
const previous = await readFile(stamp, "utf8").catch(() => null);
if (previous !== lock || !(await exists("node_modules/.package-lock.json"))) {
  await command("npm", ["ci", "--no-audit", "--no-fund"]);
  await mkdir("node_modules", { recursive: true });
  await writeFile(stamp, lock);
}
if (await exists("node_modules/.bin/playwright"))
  await command("node_modules/.bin/playwright", ["install", "chromium"]);
// Warm compiled packages on this checkpoint; a source defect must remain repairable
// by the implementation agent. Only the approved checks certify the saved revision.
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
if (packageJson.scripts?.build) {
  await command("npm", ["run", "build"], { warmup: true });
}
await command("docker", ["info", "--format", "Docker daemon ready (storage: {{.Driver}})"]);
// Daemon readiness alone does not prove that its backing filesystem can run a workload.
// The installed static Docker CLI supplies a network-free, installation-owned test image.
const context = await mkdtemp(join(tmpdir(), "kestrel-docker-probe-"));
const image = `kestrel-preparation-probe:${randomUUID()}`;
let built = false;
try {
  await copyFile("/usr/local/bin/docker", join(context, "docker"));
  await writeFile(
    join(context, "Dockerfile"),
    'FROM scratch\nCOPY docker /docker\nRUN ["/docker", "--version"]\nENTRYPOINT ["/docker", "--version"]\n',
  );
  await command("docker", ["build", "--network=none", "--tag", image, context]);
  built = true;
  await command("docker", ["run", "--rm", "--network=none", "--read-only", image]);
  console.log("Docker build and workload ready");
} finally {
  try {
    if (built) await command("docker", ["image", "rm", "--force", image]);
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}
// An empty daemon can run the probe yet still leave project image downloads/builds
// inside a test's short setup deadline. Prepare the declared root image first.
// Its cache remains private to this operation and is removed with the outer volume.
if (await exists("Dockerfile")) {
  if (
    await command(
      "docker",
      ["build", "--tag", `kestrel-preparation-project:${randomUUID()}`, "."],
      {
        warmup: true,
      },
    )
  )
    console.log("Project container image ready");
}
if (warmupFailures.length > 0)
  console.warn(
    `Project source warm-up failures: ${warmupFailures.join("; ")}. Required verification still applies.`,
  );
console.log("Execution environment ready; project verification remains required");
