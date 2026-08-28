import { beforeEach, describe, expect, it, vi } from "vitest";

import { LocalSourceError } from "@kestrel/local-source";

const mocks = vi.hoisted(() => ({
  inspectRepository: vi.fn(),
  resolveRepository: vi.fn(),
  retainRevision: vi.fn(),
  withGitHubPullRequestObjects: vi.fn(),
}));

vi.mock("@kestrel/local-source", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kestrel/local-source")>()),
  inspectRepository: mocks.inspectRepository,
  resolveRepository: mocks.resolveRepository,
  retainRevision: mocks.retainRevision,
  withGitHubPullRequestObjects: mocks.withGitHubPullRequestObjects,
}));

import { createLocalRepositoryService } from "./local-repository-sources.js";

const projectId = "018f0f89-9a22-7864-aac2-8df71bf60420";
const revisionId = "018f0f89-9a21-7271-b92d-f1cb0d48bb47";
const repositoryId = "018f0f89-9a1d-7484-b224-866ef9d69990";
const repository = {
  displayName: "review-source",
  path: "/validated/operator/review-source",
  relativePath: "review-source",
  repositoryId,
  rootId: "018f0f89-9a1f-72ae-82c4-ef8ee27d6932",
  rootPath: "/validated/operator",
};
const inspection = {
  githubRepository: { name: "review-source", owner: "kestrel" },
  objectDirectories: ["/validated/operator/review-source/.git/objects"],
  objectFormat: "sha1" as const,
  sourceIdentity: "c".repeat(64),
};
const selection = {
  base: { objectId: "a".repeat(40), ref: "main" },
  head: { objectId: "b".repeat(40), ref: "review-source" },
  objectFormat: "sha1" as const,
  projectId,
  pullRequestNumber: 42,
  repository: { name: "review-source", owner: "kestrel" },
  repositoryId,
};
const config = {
  artifactRoot: "/validated/artifacts",
  gitExecutable: "/usr/bin/git",
  gitObjectReadTimeoutMs: 60_000,
  maxBytes: 1_048_576,
  maxObjects: 1_000,
  repositoryRoots: [{ id: repository.rootId, path: repository.rootPath }],
};

describe("observed Review Revision source orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRepository.mockResolvedValue(repository);
    mocks.inspectRepository.mockResolvedValue(inspection);
  });

  it("tries local retention before fetching and supplies only the acquired fallback", async () => {
    const order: string[] = [];
    const artifact = {
      artifactLocator: `projects/${projectId}/revisions/${revisionId}`,
      manifestDigest: "d".repeat(64),
      objectCount: 4,
      retainedBytes: 1024,
    };
    const acquired = {
      inspection: {
        ...inspection,
        githubRepository: null,
        objectDirectories: ["/validated/artifacts/acquired.git/objects"],
        sourceIdentity: "e".repeat(64),
      },
      repository: {
        ...repository,
        path: "/validated/artifacts/acquired.git",
        rootPath: "/validated/artifacts",
      },
    };
    mocks.retainRevision
      .mockImplementationOnce(() => {
        order.push("local");
        return Promise.reject(new LocalSourceError("object_missing"));
      })
      .mockImplementationOnce(() => {
        order.push("fallback");
        return Promise.resolve(artifact);
      });
    mocks.withGitHubPullRequestObjects.mockImplementation(
      async (_config, _input, action: (source: typeof acquired) => Promise<unknown>) => {
        order.push("fetch");
        return action(acquired);
      },
    );
    const service = createLocalRepositoryService(config, { query: vi.fn() } as never);
    const prepared = await service.prepareObserved(selection);
    const controller = new AbortController();

    await expect(
      service.retain({
        prepared,
        projectId,
        revisionId,
        signal: controller.signal,
      }),
    ).resolves.toEqual(artifact);
    expect(order).toEqual(["local", "fetch", "fallback"]);
    expect(mocks.withGitHubPullRequestObjects).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        base: selection.base,
        head: selection.head,
        projectId,
        pullRequestNumber: 42,
        repository: selection.repository,
        signal: controller.signal,
      }),
      expect.any(Function),
    );
    expect(mocks.retainRevision.mock.calls[1]?.[1]).toMatchObject({
      fallbackSources: [acquired],
    });
  });

  it("refuses network acquisition after the clone GitHub identity changes", async () => {
    mocks.retainRevision.mockRejectedValueOnce(new LocalSourceError("object_missing"));
    const service = createLocalRepositoryService(config, { query: vi.fn() } as never);
    const prepared = await service.prepareObserved(selection);
    mocks.inspectRepository.mockResolvedValueOnce({
      ...inspection,
      githubRepository: { name: "retargeted", owner: "attacker" },
    });

    await expect(service.retain({ prepared, projectId, revisionId })).rejects.toMatchObject({
      code: "repository_not_available",
    });
    expect(mocks.withGitHubPullRequestObjects).not.toHaveBeenCalled();
  });
});
