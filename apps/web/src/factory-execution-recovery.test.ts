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
  container: {
    id: string;
    name: string;
    labels: Record<string, string>;
    mounts?: unknown;
  } | null = {
    id,
    name: `/${name}`,
    labels: { "kestrel.factory.execution": name },
  },
  mode = "normal",
  privateStorage: { name: string; driver: "local"; createdAt: string } | null = null,
) {
  const cwd = await mkdtemp(join(tmpdir(), "kestrel-container-recovery-"));
  directories.push(cwd);
  const state = join(cwd, "state.json");
  const log = join(cwd, "calls.jsonl");
  const dockerExecutable = join(cwd, "docker.mjs");
  const volumePath = join(cwd, "volume.json");
  await writeFile(
    volumePath,
    JSON.stringify(
      privateStorage === null
        ? null
        : {
            Name: privateStorage.name,
            Driver: privateStorage.driver,
            CreatedAt: privateStorage.createdAt,
            Scope: "local",
            Mountpoint: "/var/lib/docker/volumes/" + privateStorage.name + "/_data",
          },
    ),
  );
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
const volumePath=${JSON.stringify(volumePath)};
const volume=JSON.parse(await readFile(volumePath,'utf8'));
if (args[0] === "info") {
  const calls = (await readFile(${JSON.stringify(log)}, "utf8")).trim().split("\\n").map(line => JSON.parse(line));
  const changed = (mode === "daemon_changed" && calls.filter(call => call[0] === "info").length > 1)
    || (mode === "daemon_changed_after_remove" && !container);
  console.log(mode === "invalid_daemon" ? "" : changed ? "other-daemon" : ${JSON.stringify(daemonId)});
} else if (args[0] === "container" && args[1] === "ls") {
  const filter = args[args.indexOf("--filter") + 1];
  if (container && (filter === "id=" + container.id || filter === "name=^" + container.name + "$"))
    console.log(container.id);
} else if (args[0] === "create") {
  if (container) process.exit(1);
  const created = {
    id: ${JSON.stringify(id)},
    name: "/" + args[args.indexOf("--name") + 1],
    image: args.at(-1),
    labels: {
      "kestrel.factory.execution": args[args.indexOf("--label") + 1].split("=")[1],
    },
  };
  await writeFile(statePath, JSON.stringify(created));
  console.log(created.id);
} else if (args[0] === "inspect") {
  if (!container || args.at(-1) !== container.id) process.exit(1);
  console.log(JSON.stringify(container));
} else if (args[0] === "rm" && args[1] === "--force" && args[2] === container?.id) {
  if (mode !== "retained") await writeFile(statePath, "null");
  if (args.includes('--volumes') && mode !== 'volume_left') await writeFile(volumePath,'null');
} else if (args[0] === 'volume') {
  if (args[1] === 'ls') { if(volume)console.log(volume.Name); }
  else if(args[1] === 'inspect') { if(!volume)process.exit(1);console.log(JSON.stringify(mode === 'volume_changed' ? {...volume,CreatedAt:'2026-10-05T15:00:00Z'} : volume)); }
  else if(args[1] === 'rm') { if(mode === 'volume_busy')process.exit(1);await writeFile(volumePath,'null'); }
  else process.exit(1);
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

const storageReceipt = {
  name: "e".repeat(64),
  driver: "local" as const,
  createdAt: "2026-10-05T14:00:00Z",
};
it.each([id, null])(
  "keeps unidentified required storage fenced after parent loss (ID=%s)",
  async (persistedId) => {
    const { recover, calls } = await fixture(null, "normal", storageReceipt);
    const identified = vi.fn(() => Promise.resolve());
    await expect(
      recover(
        {
          name,
          id: persistedId,
          daemonId,
          image: `sha256:${"1".repeat(64)}`,
          privateStorageRequired: true,
        },
        identified,
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toMatchObject({ code: "stop_unconfirmed" });
    expect(identified).not.toHaveBeenCalled();
    expect(
      (await calls()).some(
        (args) =>
          args[0] === "create" || args[0] === "rm" || (args[0] === "volume" && args[1] === "rm"),
      ),
    ).toBe(false);
  },
);

it("persists anonymous storage before removing an orphan container and confirms its absence", async () => {
  const owned = {
    id,
    name: `/${name}`,
    labels: {
      "kestrel.factory.execution": name,
      "kestrel.factory.private-docker-storage": "anonymous",
    },
    mounts: [
      {
        Type: "volume",
        Name: storageReceipt.name,
        Source: `/var/lib/docker/volumes/${storageReceipt.name}/_data`,
        Destination: "/var/lib/docker",
        RW: true,
      },
    ],
  };
  const { recover, calls } = await fixture(owned, "normal", storageReceipt);
  const identified = vi.fn(async () => {
    expect((await calls()).some((args) => args[0] === "rm")).toBe(false);
  });
  await expect(
    recover(
      { name, id: null, daemonId, privateStorageRequired: true },
      identified,
      AbortSignal.timeout(5_000),
    ),
  ).resolves.toEqual({ name, id });
  expect(identified).toHaveBeenCalledWith(id, storageReceipt);
  expect((await calls()).find((args) => args[0] === "rm")).toEqual([
    "rm",
    "--force",
    id,
    "--volumes",
  ]);
  expect((await calls()).some((args) => args[0] === "volume" && args[1] === "ls")).toBe(true);
});

it("cleans retained anonymous storage after an interrupted container removal", async () => {
  const { recover, calls } = await fixture(null, "normal", storageReceipt);
  const identified = vi.fn(() => Promise.resolve());
  await expect(
    recover(
      { name, id, daemonId, privateStorage: storageReceipt },
      identified,
      AbortSignal.timeout(5_000),
    ),
  ).resolves.toEqual({ name, id });
  expect(identified).toHaveBeenCalledWith(id, storageReceipt);
  expect((await calls()).filter((args) => args[0] === "volume" && args[1] === "rm")).toEqual([
    ["volume", "rm", storageReceipt.name],
  ]);
});

it.each(["volume_changed", "volume_busy"])(
  "retains the stop fence for %s storage",
  async (mode) => {
    const { recover, calls } = await fixture(null, mode, storageReceipt);
    await expect(
      recover(
        { name, id, daemonId, privateStorage: storageReceipt },
        () => Promise.resolve(),
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toMatchObject({ code: "stop_unconfirmed" });
    if (mode === "volume_changed")
      expect((await calls()).some((args) => args[0] === "volume" && args[1] === "rm")).toBe(false);
  },
);

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

it("claims an absent reserved name with the frozen image before confirming teardown", async () => {
  const image = `sha256:${"1".repeat(64)}`;
  const { recover, calls } = await fixture(null);
  const identified = vi.fn(() => Promise.resolve());

  await expect(
    recover({ name, id: null, daemonId, image }, identified, AbortSignal.timeout(5_000)),
  ).resolves.toEqual({ name, id });

  expect(identified).toHaveBeenCalledWith(id);
  const create = (await calls()).find((args) => args[0] === "create");
  expect(create).toEqual(expect.arrayContaining(["--entrypoint", "/bin/true", image]));
  expect((await calls()).filter((args) => args[0] === "rm")).toEqual([["rm", "--force", id]]);
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
