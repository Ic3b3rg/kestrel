import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { SourceAuthorization } from "@kestrel/contracts";
import {
  previewSourceAuthorization,
  confirmSourceAuthorization,
  SourceAuthorizationError,
  type SourceAuthorizationPreview,
} from "@kestrel/local-source";

export interface SourceOnboardingService {
  chooseFolder(): Promise<SourceAuthorization>;
  confirmFolder(previewId: string): Promise<SourceAuthorization>;
}

export async function chooseNativeFolder(): Promise<string | null> {
  if (process.platform !== "darwin")
    throw new SourceAuthorizationError(
      "The native folder chooser is unavailable. Run the authorization command from the repository folder on this workstation.",
    );
  try {
    const result = await promisify(execFile)(
      "/usr/bin/osascript",
      [
        "-e",
        'try\nreturn POSIX path of (choose folder with prompt "Choose a Git repository or its immediate parent folder for Kestrel")\non error number -128\nreturn ""\nend try',
      ],
      { timeout: 120_000, maxBuffer: 16_384 },
    );
    return result.stdout.trim() || null;
  } catch {
    throw new SourceAuthorizationError(
      "The workstation folder chooser did not complete. Try Local folder again or authorize from the terminal.",
    );
  }
}

export function createSourceOnboardingService(
  env: NodeJS.ProcessEnv = process.env,
  choose: () => Promise<string | null> = chooseNativeFolder,
): SourceOnboardingService {
  const previews = new Map<
    string,
    { preview: SourceAuthorizationPreview; expires: number; authorized: boolean }
  >();
  let choosing = false;
  return {
    async chooseFolder() {
      if (choosing)
        throw new SourceAuthorizationError("A folder chooser is already open on this workstation.");
      choosing = true;
      try {
        for (const [id, entry] of previews) if (entry.expires <= Date.now()) previews.delete(id);
        if (previews.size >= 16)
          throw new SourceAuthorizationError(
            "Too many folder previews are open. Wait a few minutes and try again.",
          );
        const path = await choose();
        if (path === null) return { state: "cancelled" };
        const preview = await previewSourceAuthorization(path, env);
        const previewId = randomUUID();
        previews.set(previewId, { preview, expires: Date.now() + 300_000, authorized: false });
        return {
          state: "preview",
          previewId,
          repositories: preview.repositories.map(({ displayName, repositoryId }) => ({
            displayName,
            repositoryId,
          })),
          skipped: preview.skipped,
        };
      } finally {
        choosing = false;
      }
    },
    async confirmFolder(previewId) {
      const entry = previews.get(previewId);
      if (entry === undefined || entry.expires <= Date.now())
        throw new SourceAuthorizationError("This folder preview expired. Choose the folder again.");
      if (!entry.authorized) {
        await confirmSourceAuthorization(entry.preview, env);
        entry.authorized = true;
      }
      return { state: "authorized" };
    },
  };
}
