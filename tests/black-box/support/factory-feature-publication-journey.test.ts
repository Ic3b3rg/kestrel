import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createPublicationGitWrapper } from "./factory-feature-publication-journey.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("loses only the response after the delegated push has completed, preserving every argument", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-publication-wrapper-"));
  directories.push(directory);
  const delegate = join(directory, "delegate.cjs");
  const callsPath = join(directory, "calls.jsonl");
  const statePath = join(directory, "state.json");
  const wrapper = join(directory, "wrapper.cjs");
  await writeFile(
    delegate,
    `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(process.argv.slice(2))+'\\n');process.stdout.write('completed push\\n');process.stderr.write('delegate diagnostic\\n');`,
    { mode: 0o700 },
  );
  await writeFile(
    statePath,
    JSON.stringify({ controls: { losePushResponse: true }, calls: [], pushes: 0 }),
  );
  await writeFile(wrapper, createPublicationGitWrapper({ delegate, statePath }));
  const argv = [
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "--porcelain",
    "--",
    "https://github.com/Ic3b3rg/kestrel.git",
    "literal'\"$():refs/heads/feature",
  ];
  const first = await execFileAsync(process.execPath, [wrapper, ...argv]).then(
    (result) => ({ code: 0, ...result }),
    (error: unknown) => {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        !("stdout" in error) ||
        !("stderr" in error)
      )
        throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    },
  );
  expect(first).toMatchObject({ code: 1, stdout: "" });
  expect(JSON.parse((await readFile(callsPath, "utf8")).trim())).toEqual(argv);
  expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
    pushes: 1,
    controls: { losePushResponse: false },
  });
  const ordinaryArgs = ["ls-remote", "--refs", "--", "a path with spaces and $()"];
  expect(await execFileAsync(process.execPath, [wrapper, ...ordinaryArgs])).toMatchObject({
    stdout: "completed push\n",
    stderr: "delegate diagnostic\n",
  });
  expect(
    (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown),
  ).toEqual([argv, ordinaryArgs]);
  expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ pushes: 1 });
});
