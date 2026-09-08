import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { createCodexExecutionContainerRecovery } from "./codex-execution-runtime.js";

const name = `kestrel-factory-${"1".repeat(32)}`;
const id = "a".repeat(64);
const daemonId = "c20f7230-59a2-4824-a2f4-fda71c982ee6";
const directories: string[] = [];

async function fixture(
  container: { id: string; name: string; labels: Record<string, string> } | null = {
    id,
    name: `/${name}`,
    labels: { "kestrel.factory.execution": name },
  },
  mode = "normal",
) {
  const cwd = await mkdtemp(join(tmpdir(), "kestrel-container-recovery-"));
  directories.push(cwd);
  const state = join(cwd, "state.json");
  const log = join(cwd, "calls.jsonl");
  const dockerExecutable = join(cwd, "docker.mjs");
  await writeFile(state, JSON.stringify(container));
  await writeFile(log, "");
  await writeFile(
    dockerExecutable,
    `#!${process.execPath}
import { appendFile, readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
await appendFile(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const mode = ${JSON.stringify(mode)};
if (mode === "unavailable") process.exit(1);
if (mode === "timeout") await new Promise(resolve => setTimeout(resolve, 60000));
const statePath = ${JSON.stringify(state)};
const container = JSON.parse(await readFile(statePath, "utf8"));
if (args[0] === "info") {
  const calls = (await readFile(${JSON.stringify(log)}, "utf8")).trim().split("\\n").map(line => JSON.parse(line));
  const changed = (mode === "daemon_changed" && calls.filter(call => call[0] === "info").length > 1)
    || (mode === "daemon_changed_after_remove" && !container);
  console.log(mode === "invalid_daemon" ? "" : changed ? "other-daemon" : ${JSON.stringify(daemonId)});
} else if (args[0] === "container" && args[1] === "ls") {
  const filter = args[args.indexOf("--filter") + 1];
  if (container && (filter === "id=" + container.id || filter === "name=^" + container.name + "$"))
    console.log(container.id);
} else if (args[0] === "inspect") {
  if (!container || args.at(-1) !== container.id) process.exit(1);
  console.log(JSON.stringify(container));
} else if (args[0] === "rm" && args[1] === "--force" && args[2] === container?.id) {
  if (mode !== "retained") await writeFile(statePath, "null");
} else process.exit(1);
`,
    { mode: 0o700 },
  );
  return {
    recover: createCodexExecutionContainerRecovery({ dockerExecutable }),
    dockerExecutable,
    calls: async () =>
      z.array(z.array(z.string())).parse(
        (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line): unknown => JSON.parse(line)),
      ),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

it.each([id, null])(
  "recovers an orphan by exact identity without starting any runtime (persisted ID=%s)",
  async (persistedId) => {
    const { recover, calls } = await fixture();
    const identified = vi.fn(async (found: string) => {
      expect(found).toBe(id);
      expect((await calls()).some((args) => args[0] === "rm")).toBe(false);
    });
    await expect(
      recover({ name, id: persistedId }, identified, AbortSignal.timeout(5_000)),
    ).resolves.toEqual({
      name,
      id,
    });
    expect(identified).toHaveBeenCalledOnce();
    expect((await calls()).filter((args) => args[0] === "rm")).toEqual([["rm", "--force", id]]);
    expect(
      (await calls()).every((args) =>
        ["info", "container", "inspect", "rm"].includes(args[0] ?? ""),
      ),
    ).toBe(true);
  },
);

it("persists a discovered identity before teardown so a crash cannot erase its evidence", async () => {
  const { recover, calls } = await fixture();
  const identified = vi.fn(() => Promise.reject(new Error("database unavailable")));
  await expect(
    recover({ name, id: null }, identified, AbortSignal.timeout(5_000)),
  ).rejects.toMatchObject({ code: "stop_unconfirmed" });
  expect(identified).toHaveBeenCalledWith(id);
  expect((await calls()).some((args) => args[0] === "rm")).toBe(false);
});

it("retains an absent reservation without an ID because a delayed create may still complete", async () => {
  const { recover, calls } = await fixture(null);
  const identified = vi.fn();
  await expect(
    recover({ name, id: null }, identified, AbortSignal.timeout(5_000)),
  ).rejects.toMatchObject({ code: "stop_unconfirmed" });
  expect(identified).not.toHaveBeenCalled();
  expect((await calls()).some((args) => args[0] === "rm")).toBe(false);
});

it("retains an initially absent ID because the current Docker daemon may differ from the original", async () => {
  const { recover, calls } = await fixture(null);
  const identified = vi.fn();
  await expect(recover({ name, id }, identified, AbortSignal.timeout(5_000))).rejects.toMatchObject(
    { code: "stop_unconfirmed" },
  );
  expect(identified).not.toHaveBeenCalled();
  expect((await calls()).some((args) => args[0] === "rm")).toBe(false);
});

it("recovers a removal-before-stopped_at crash only on the persisted Docker daemon", async () => {
  const { recover, calls } = await fixture(null);
  const identified = vi.fn(() => Promise.resolve());
  await expect(
    recover({ name, id, daemonId }, identified, AbortSignal.timeout(5_000)),
  ).resolves.toEqual({ name, id });
  expect(identified).toHaveBeenCalledWith(id);
  expect((await calls()).filter((args) => args[0] === "info").length).toBeGreaterThanOrEqual(2);
  expect((await calls()).some((args) => args[0] === "rm")).toBe(false);
});

it("retains an absent ID when a different Docker daemon answers the probe", async () => {
  const { recover, calls } = await fixture(null);
  await expect(
    recover({ name, id, daemonId: "other-daemon" }, async () => {}, AbortSignal.timeout(5_000)),
  ).rejects.toMatchObject({ code: "stop_unconfirmed" });
  expect((await calls()).some((args) => args[0] === "rm")).toBe(false);
});

it.each(["daemon_changed", "daemon_changed_after_remove", "invalid_daemon"])(
  "does not claim a stopped writer when daemon provenance becomes uncertain (%s)",
  async (mode) => {
    const { recover } = await fixture(undefined, mode);
    await expect(
      recover({ name, id, daemonId }, async () => {}, AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({ code: "stop_unconfirmed" });
  },
);

it.each([
  { id: "b".repeat(64), name: `/${name}`, labels: { "kestrel.factory.execution": name } },
  { id, name: "/foreign", labels: { "kestrel.factory.execution": name } },
  { id, name: `/${name}`, labels: { "kestrel.factory.execution": "foreign" } },
])("never stops a conflicting Docker identity: %j", async (container) => {
  const { recover, calls } = await fixture(container);
  const identified = vi.fn();
  await expect(recover({ name, id }, identified, AbortSignal.timeout(5_000))).rejects.toMatchObject(
    { code: "stop_unconfirmed" },
  );
  expect(identified).not.toHaveBeenCalled();
  expect((await calls()).some((args) => args[0] === "rm")).toBe(false);
});

it.each(["unavailable", "retained"])("retains uncertainty when Docker is %s", async (mode) => {
  const { recover } = await fixture(undefined, mode);
  await expect(
    recover({ name, id }, async () => {}, AbortSignal.timeout(5_000)),
  ).rejects.toMatchObject({ code: "stop_unconfirmed" });
});

it("bounds a hung Docker probe by the reconciliation deadline", async () => {
  const { recover } = await fixture(undefined, "timeout");
  await expect(
    recover({ name, id }, async () => {}, AbortSignal.timeout(100)),
  ).rejects.toMatchObject({ code: "stop_unconfirmed" });
}, 2_000);
