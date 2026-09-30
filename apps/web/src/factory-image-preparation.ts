import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const preparationScript = fileURLToPath(
  new URL("../../../scripts/factory-execution-image.mjs", import.meta.url),
);
const imageIdPattern = /^sha256:[a-f0-9]{64}$/u;

export function createFactoryImagePreparer({
  dockerExecutable,
  signal,
  onFailure,
}: {
  dockerExecutable?: string;
  signal: AbortSignal;
  onFailure?: (error: unknown) => void;
}): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () => {
    signal.throwIfAborted();
    if (pending === undefined) {
      const environment = {
        ...process.env,
        ...(dockerExecutable === undefined ? {} : { DOCKER_BIN: dockerExecutable }),
      };
      pending = exec(process.execPath, [preparationScript, "--ensure"], {
        env: environment,
        maxBuffer: 64 * 1024,
        signal,
        timeout: 600_000,
      })
        .then(({ stdout }) => {
          const imageId = stdout.match(/Factory executor ready: (sha256:[a-f0-9]{64})/u)?.[1];
          if (imageId === undefined || !imageIdPattern.test(imageId))
            throw new Error("Factory image preparation did not return an immutable image ID");
          return imageId;
        })
        .catch((error: unknown) => {
          onFailure?.(error);
          throw error;
        })
        .finally(() => {
          pending = undefined;
        });
    }
    return pending;
  };
}
