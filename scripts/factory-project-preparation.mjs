// Runs only in the installation-authorized trusted Project execution container.
// Preparation is not an acceptance certificate. Its failures stop execution.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, readFile, writeFile, mkdir } from "node:fs/promises";

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
await command("docker", ["info", "--format", "Docker environment ready"]);
