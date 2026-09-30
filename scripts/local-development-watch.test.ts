import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.each(["web", "worker"])(
  "%s development command reloads TypeScript and shared sources and recovers after errors",
  async (service) => {
    const repositoryRoot = resolve(import.meta.dirname, "..");
    const workspace = join(repositoryRoot, "apps", service);
    const manifest = JSON.parse(await readFile(join(workspace, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const command = manifest.scripts.dev;
    expect(command).toBeDefined();
    if (!command) throw new Error("Missing development command");
    const [executable, ...args] = command.split(" ");
    expect(executable).toBe("node");
    const directory = await realpath(await mkdtemp(join(tmpdir(), "kestrel-watch-test-")));
    const shared = join(directory, "packages", "shared");
    const source = join(shared, "src", "index.ts");
    const fixtureWorkspace = join(directory, "apps", service);
    const entry = join(fixtureWorkspace, args.at(-1) ?? "missing");
    const program = `import { value } from "@fixture/shared";
const message: string = value;
console.log("fixture:" + message);
setInterval(() => {}, 1000);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => { console.log("drained:" + message); process.exit(0); }, message === "initial-source" ? 6000 : 11000);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
`;
    let child: ReturnType<typeof spawn> | undefined;
    let output = "";
    try {
      await mkdir(join(shared, "src"), { recursive: true });
      await mkdir(join(fixtureWorkspace, "src"), { recursive: true });
      await mkdir(join(directory, "scripts"));
      await writeFile(
        join(directory, "scripts", "watch-service.mjs"),
        await readFile(join(repositoryRoot, "scripts", "watch-service.mjs")),
      );
      await writeFile(join(fixtureWorkspace, "package.json"), JSON.stringify({ type: "module" }));
      await mkdir(join(directory, "node_modules", "@fixture"), { recursive: true });
      await symlink(shared, join(directory, "node_modules", "@fixture", "shared"), "dir");
      await symlink(
        join(repositoryRoot, "node_modules", "tsx"),
        join(directory, "node_modules", "tsx"),
        "dir",
      );
      await writeFile(
        join(shared, "package.json"),
        JSON.stringify({
          type: "module",
          exports: { development: "./src/index.ts", default: "./built.js" },
        }),
      );
      await writeFile(join(shared, "built.js"), 'export const value = "stale-build";');
      await writeFile(source, 'export const value: string = "initial-source";');
      await writeFile(entry, program);
      child = spawn(process.execPath, args, {
        cwd: fixtureWorkspace,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      await expect.poll(() => output, { timeout: 20_000 }).toContain("fixture:initial-source");
      expect(output).not.toContain("fixture:stale-build");
      await writeFile(source, 'export const value: string = "updated-shared-source";');
      await expect
        .poll(() => output, { timeout: 20_000 })
        .toContain("fixture:updated-shared-source");
      expect(output).toContain("drained:initial-source");
      output = "";
      await writeFile(entry, "const broken: = ;");
      await expect.poll(() => output, { timeout: 20_000 }).toContain("TransformError");
      await writeFile(entry, program.replace('"fixture:"', '"recovered:"'));
      await expect
        .poll(() => output, { timeout: 20_000 })
        .toContain("recovered:updated-shared-source");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise<void>((resolveStopped) =>
          child?.once("close", () => resolveStopped()),
        );
        output = "";
        if (process.platform !== "win32" && child.pid !== undefined)
          process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
        await stopped;
      }
      await rm(directory, { recursive: true, force: true });
    }
    expect(output).toContain("drained:updated-shared-source");
  },
  70_000,
);
