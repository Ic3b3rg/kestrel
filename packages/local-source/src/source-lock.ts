import { randomUUID } from "node:crypto";
import { link, lstat, readFile, unlink, writeFile } from "node:fs/promises";

/** Publish a complete owner record atomically; an interrupted owner can be reconciled. */
export async function acquireSourceLock(path: string): Promise<() => Promise<void>> {
  const candidate = `${path}.${String(process.pid)}.${randomUUID()}`;
  await writeFile(candidate, String(process.pid), { mode: 0o600, flag: "wx" });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await link(candidate, path);
        const owned = await lstat(path);
        return async () => {
          const current = await lstat(path).catch(() => null);
          if (current?.ino === owned.ino && current.dev === owned.dev) await unlink(path);
        };
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        const previous = await lstat(path);
        if (
          !previous.isFile() ||
          previous.isSymbolicLink() ||
          (process.getuid !== undefined && previous.uid !== process.getuid())
        )
          throw new Error("Source operation lock ownership is unavailable.", { cause: error });
        const pid = Number(await readFile(path, "utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 0)
          throw new Error("Source operation lock ownership is unavailable.", { cause: error });
        try {
          process.kill(pid, 0);
        } catch (failure) {
          if (failure instanceof Error && "code" in failure && failure.code === "ESRCH") {
            const current = await lstat(path).catch(() => null);
            if (current?.ino === previous.ino && current.dev === previous.dev) await unlink(path);
            continue;
          }
        }
        throw new Error(
          "Another source operation is still running. Wait for it to finish, then retry.",
          { cause: error },
        );
      }
    }
    throw new Error("Source operation ownership changed. Retry the operation.");
  } finally {
    await unlink(candidate);
  }
}
