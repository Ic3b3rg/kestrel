import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { CodexExecutionRuntimeOptions } from "./codex-execution-runtime.js";
import { FactoryExecutionError } from "./factory-sandbox.js";

const exec = promisify(execFile);
const GiB = 1024 ** 3;
const script = fileURLToPath(
  new URL("../../../scripts/factory-project-image.mjs", import.meta.url),
);
const capacitySchema = z.object({ memoryBytes: z.int().positive(), cpus: z.int().positive() });
export interface FactoryProjectEnvironment {
  runtimeOptions: Pick<
    CodexExecutionRuntimeOptions,
    "containerImage" | "containerResources" | "projectEnvironment"
  >;
  release(): void;
}
export type FactoryProjectEnvironmentPreparer = (
  request: { projectId: string; runId: string },
  signal: AbortSignal,
  activity: (summary: string) => Promise<void>,
) => Promise<FactoryProjectEnvironment | null>;

/** One installation-owned heavy slot. Repository instructions cannot select this capability. */
export function createFactoryProjectEnvironmentPreparer({
  authorizedProjects,
  dockerExecutable = "docker",
  isReservationReleased = () => Promise.resolve(false),
}: {
  authorizedProjects: readonly string[];
  dockerExecutable?: string;
  isReservationReleased?: (runId: string) => Promise<boolean>;
}): FactoryProjectEnvironmentPreparer {
  const authorized = new Set(authorizedProjects);
  let occupied: { runId: string; token: symbol } | null = null;
  let image: Promise<string> | undefined;
  const cli = async (args: string[], signal: AbortSignal) =>
    (
      await exec(dockerExecutable, args, { signal, timeout: 15_000, maxBuffer: 64 * 1024 })
    ).stdout.trim();
  return async ({ projectId, runId }, signal, activity) => {
    signal.throwIfAborted();
    if (!authorized.has(projectId)) return null;
    let waiting = false;
    while (occupied !== null) {
      const prior = occupied;
      if (await isReservationReleased(prior.runId)) {
        if (occupied === prior) occupied = null;
        continue;
      }
      if (!waiting) {
        await activity("Waiting for local execution capacity.");
        waiting = true;
      }
      await delay(5_000, undefined, { signal });
    }
    // Reserve synchronously before any await so concurrent Project claims cannot overcommit.
    const token = Symbol(runId);
    occupied = { runId, token };
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        if (occupied?.token === token) occupied = null;
      }
    };
    try {
      const capacity = capacitySchema.parse(
        JSON.parse(
          await cli(["info", "--format", '{"memoryBytes":{{.MemTotal}},"cpus":{{.NCPU}}}'], signal),
        ),
      );
      const memoryBytes = Math.min(5.5 * GiB, Math.floor(capacity.memoryBytes - 1.5 * GiB));
      if (memoryBytes < 4 * GiB)
        throw new FactoryExecutionError(
          "sandbox_unavailable",
          "The Docker VM has insufficient capacity for this Project's Docker-backed checks. The prepared environment needs at least 4 GiB plus 1.5 GiB reserved for other work.",
        );
      for (;;) {
        const percentages = (
          await cli(["stats", "--no-stream", "--format", "{{.MemPerc}}"], signal)
        )
          .split(/\s+/u)
          .filter(Boolean);
        const usedPercent = percentages.reduce(
          (total, value) =>
            total +
            z
              .number()
              .min(0)
              .max(100)
              .parse(Number(value.replace("%", ""))),
          0,
        );
        if (capacity.memoryBytes * (1 - usedPercent / 100) >= memoryBytes + GiB) break;
        if (!waiting) {
          await activity("Waiting for local execution capacity.");
          waiting = true;
        }
        await delay(5_000, undefined, { signal });
      }
      await activity(
        `Preparing Node, Docker and Chromium · ${String(Math.round((memoryBytes / GiB) * 10) / 10)} GiB · 512 processes · ${String(Math.min(2, capacity.cpus))} CPUs.`,
      );
      image ??= exec(process.execPath, [script], {
        env: { ...process.env, DOCKER_BIN: dockerExecutable },
        signal,
        timeout: 900_000,
        maxBuffer: 64 * 1024,
      })
        .then(({ stdout }) => {
          const pinned = stdout.match(
            /Factory project executor ready: (sha256:[a-f0-9]{64})/u,
          )?.[1];
          if (pinned === undefined) throw new Error("Invalid prepared Project image");
          return pinned;
        })
        .catch((error: unknown) => {
          image = undefined;
          throw error;
        });
      const containerImage = await image;
      return {
        runtimeOptions: {
          containerImage,
          projectEnvironment: "node_docker",
          containerResources: {
            memoryBytes,
            pidsLimit: 512,
            nanoCpus: Math.min(2, capacity.cpus) * 1_000_000_000,
            tmpfsBytes: 512 * 1024 ** 2,
          },
        },
        release,
      };
    } catch (error) {
      release();
      throw error;
    }
  };
}
