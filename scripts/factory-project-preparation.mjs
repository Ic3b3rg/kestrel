// Runs only in the installation-authorized trusted Project execution container.
// Preparation is not an acceptance certificate. Its failures stop execution.
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, copyFile, readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.chdir("/workspace");
async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}
async function command(program, args) {
  console.log(`Preparing environment: ${program} ${args.join(" ")}`);
  const child = spawn(program, args, { stdio: "inherit", shell: false });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`Environment preparation failed: ${program} (${signal ?? code})`)),
    );
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
// Compiled workspace packages are prerequisites of the tests in this project.
// Rebuild after every new committed checkpoint; never reuse another revision's build.
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
if (packageJson.scripts?.build) {
  await command("npm", ["run", "build"]);
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
