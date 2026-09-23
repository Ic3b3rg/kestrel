import { lstat, open } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

/** SQLite's OS lock is released on process exit, without unlinking another owner's file. */
export async function acquireSourceLock(path: string): Promise<() => Promise<void>> {
  try {
    const file = await open(path, "wx", 0o600);
    await file.close();
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  const file = await lstat(path);
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    (process.getuid !== undefined && file.uid !== process.getuid()) ||
    (file.mode & 0o077) !== 0
  )
    throw new Error("Source operation lock ownership is unavailable.");
  const lock = new DatabaseSync(path);
  try {
    lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    throw new Error(
      "Another source operation is still running. Wait for it to finish, then retry.",
      { cause: error },
    );
  }
  let released = false;
  return () => {
    if (!released) {
      lock.close();
      released = true;
    }
    return Promise.resolve();
  };
}
