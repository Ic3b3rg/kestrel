import { PlanningContextSchema, type PlanningContext } from "@kestrel/contracts";
import {
  inspectRepository,
  listCommitTreeEntries,
  listRepositoryReferences,
  resolveRepository,
  withGitObjectReader,
  type LocalSourceConfig,
} from "@kestrel/local-source";

function documentPriority(path: string): number {
  if (path === "AGENTS.md") return 0;
  if (path === "CONTEXT.md") return 1;
  if (path === "README.md") return 2;
  if (/^docs\/(adr|spec|factory)/u.test(path)) return 3;
  return 4;
}

/** Reads verified committed blobs only; never reads files from the working tree. */
export async function readPlanningDocuments(
  config: LocalSourceConfig,
  repositoryId: string,
  expectedSourceIdentity?: string,
): Promise<PlanningContext> {
  const repository = await resolveRepository(config, repositoryId);
  const inspection = await inspectRepository(config, repository);
  if (
    expectedSourceIdentity !== undefined &&
    inspection.sourceIdentity !== expectedSourceIdentity
  ) {
    throw new Error("The authorized planning source has changed");
  }
  const inventory = await listRepositoryReferences(config, repository);
  const commitId = inventory.references.find(({ kind }) => kind === "head")?.commitObjectId;
  if (commitId === undefined) throw new Error("The planning source has no committed HEAD");
  return withGitObjectReader(
    config,
    repository,
    inspection.objectFormat,
    inspection.objectDirectories,
    async (readObject) => {
      const entries = await listCommitTreeEntries(
        config,
        repository,
        inspection.objectFormat,
        commitId,
        inspection.objectDirectories,
        readObject,
      );
      const markdown = entries
        .filter(
          ({ path, mode, type }) =>
            type === "blob" &&
            (mode === "100644" || mode === "100755") &&
            path.endsWith(".md") &&
            path.length <= 512,
        )
        .sort(
          (a, b) =>
            documentPriority(a.path) - documentPriority(b.path) ||
            a.path.localeCompare(b.path, "en"),
        );
      const documents: PlanningContext["documents"] = [];
      let remaining = 128_000;
      let omitted = 0;
      for (const entry of markdown) {
        if (documents.length >= 24 || remaining === 0) {
          omitted += 1;
          continue;
        }
        const object = await readObject(entry.objectId);
        if (object.type !== "blob") throw new Error("Invalid planning document object");
        const content = new TextDecoder("utf-8", { fatal: true }).decode(object.content);
        const retained = content.slice(0, Math.min(24_000, remaining));
        if (retained.length !== content.length) omitted += 1;
        remaining -= retained.length;
        documents.push({ path: entry.path, objectId: entry.objectId, content: retained });
      }
      const missing = ["AGENTS.md", "CONTEXT.md"].filter(
        (path) => !documents.some((document) => document.path === path),
      );
      const notices = [
        ...(missing.length === 0 ? [] : [`No committed ${missing.join(" or ")} was available.`]),
        ...(omitted === 0
          ? []
          : [
              `${String(omitted)} Markdown documents were omitted or shortened by the context limit.`,
            ]),
        ...(documents.length === 0
          ? ["No committed Markdown context is available; clarify requirements with the Operator."]
          : []),
      ];
      return PlanningContextSchema.parse({
        commitId,
        documents,
        notice: notices.length === 0 ? null : notices.join(" "),
      });
    },
  );
}

/** Same authorized, committed snapshot as initial context, with bounded pagination. */
export async function readPlanningRepository(
  config: LocalSourceConfig,
  repositoryId: string,
  expectedSourceIdentity: string | undefined,
  commitId: string,
  request:
    | { operation: "find_files"; query: string; offset: number }
    | { operation: "read_file"; path: string; offset: number },
): Promise<unknown> {
  if (
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commitId) ||
    !Number.isSafeInteger(request.offset) ||
    request.offset < 0
  )
    throw new Error("Invalid committed read");
  if (
    request.operation === "read_file" &&
    (request.path.includes("\\") ||
      request.path.split("/").some((part) => part === "" || part === "." || part === ".."))
  )
    throw new Error("Invalid repository path");
  const repository = await resolveRepository(config, repositoryId);
  const inspection = await inspectRepository(config, repository);
  if (expectedSourceIdentity !== undefined && inspection.sourceIdentity !== expectedSourceIdentity)
    throw new Error("The authorized source changed");
  const bounded = { ...config, maxBytes: Math.min(config.maxBytes, 8 * 1024 * 1024) };
  return withGitObjectReader(
    bounded,
    repository,
    inspection.objectFormat,
    inspection.objectDirectories,
    async (readObject) => {
      const entries = (
        await listCommitTreeEntries(
          bounded,
          repository,
          inspection.objectFormat,
          commitId,
          inspection.objectDirectories,
          readObject,
        )
      ).filter((entry) => entry.type === "blob" && ["100644", "100755"].includes(entry.mode));
      if (request.operation === "find_files") {
        const matches = entries.filter((entry) =>
          entry.path.toLowerCase().includes(request.query.toLowerCase()),
        );
        const files = matches.slice(request.offset, request.offset + 100).map(({ path }) => path);
        return {
          commitId,
          files,
          total: matches.length,
          nextOffset:
            request.offset + files.length < matches.length ? request.offset + files.length : null,
        };
      }
      const entry = entries.find((entry) => entry.path === request.path);
      if (entry === undefined) throw new Error("No committed file at this path");
      const object = await readObject(entry.objectId);
      if (object.type !== "blob") throw new Error("Invalid blob");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(object.content);
      if (text.includes("\0")) throw new Error("Binary content is unavailable");
      const content = text.slice(request.offset, request.offset + 12_000);
      return {
        commitId,
        path: entry.path,
        objectId: entry.objectId,
        content,
        nextOffset:
          request.offset + content.length < text.length ? request.offset + content.length : null,
      };
    },
  );
}
