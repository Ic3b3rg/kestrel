import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFactoryProjectEnvironmentPreparer } from "./factory-project-environment.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it.each(["stopped", "reconciled"])(
  "admits only an authorized Project and releases %s execution capacity",
  async (stop) => {
    const root = await mkdtemp(join(tmpdir(), "kestrel-prepared-project-"));
    directories.push(root);
    const imageId = `sha256:${"b".repeat(64)}`;
    await writeFile(join(root, "factory-execution-image"), `${imageId}\n`, { mode: 0o600 });
    const docker = join(root, "docker");
    await writeFile(
      docker,
      `#!${process.execPath}\nconst args=process.argv.slice(2); console.log(args[0]==='info' ? JSON.stringify({memoryBytes:8*1024**3,cpus:12}) : args[0]==='stats' ? '1' : args.includes('{{.Id}} {{index .Config.Labels "org.opencontainers.image.version"}}') ? '${imageId} 0.155.1' : '${imageId}');\n`,
    );
    await chmod(docker, 0o755);
    vi.stubEnv("KESTREL_STATE_ROOT", root);
    const prepare = createFactoryProjectEnvironmentPreparer({
      authorizedProjects: ["project-a"],
      dockerExecutable: docker,
      isReservationReleased: (runId) =>
        Promise.resolve(stop === "reconciled" && confirmed && runId === "first"),
    });
    let confirmed = false;
    const signal = new AbortController().signal;
    const events: string[] = [];
    const activity = (message: string) => {
      events.push(message);
      return Promise.resolve();
    };
    await expect(
      prepare({ projectId: "project-b", runId: "ignored" }, signal, activity),
    ).resolves.toBeNull();
    const first = await prepare({ projectId: "project-a", runId: "first" }, signal, activity);
    expect(first?.runtimeOptions).toMatchObject({
      containerImage: imageId,
      projectEnvironment: "node_docker",
      containerResources: { memoryBytes: 5.5 * 1024 ** 3, pidsLimit: 512, nanoCpus: 2_000_000_000 },
    });
    const abort = new AbortController();
    const second = prepare({ projectId: "project-a", runId: "cancelled" }, abort.signal, activity);
    await vi.waitFor(() => expect(events).toContain("Waiting for local execution capacity."));
    abort.abort();
    await expect(second).rejects.toThrow();
    if (stop === "stopped") first?.release();
    else confirmed = true;
    const next = await prepare({ projectId: "project-a", runId: "next" }, signal, activity);
    expect(next).not.toBeNull();
    // A late close from a reconciled attempt cannot release the next run's slot.
    first?.release();
    const thirdAbort = new AbortController();
    const third = prepare({ projectId: "project-a", runId: "third" }, thirdAbort.signal, activity);
    thirdAbort.abort();
    await expect(third).rejects.toThrow();
    next?.release();
  },
);
