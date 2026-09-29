import { beforeEach, expect, it, vi } from "vitest";
import type * as DatabaseModule from "@kestrel/database";
import { createPool } from "@kestrel/database";
import { createPlanningReader } from "./factory-planning-reads.js";

const mocks = vi.hoisted(() => ({
  coordinates: vi.fn(),
  identify: vi.fn(),
  listIssues: vi.fn(),
  readIssue: vi.fn(),
  readIssueComments: vi.fn(),
  readRepository: vi.fn(),
}));
vi.mock("@kestrel/database", async (original) => ({
  ...(await original<typeof DatabaseModule>()),
  readProjectGitHubCoordinates: mocks.coordinates,
}));
vi.mock("./factory-github.js", () => ({ createFactoryGitHubAdapter: () => mocks }));
vi.mock("./factory-planning-source.js", () => ({ readPlanningRepository: mocks.readRepository }));
const pool = createPool("postgres://unused:unused@localhost/unused");
const config = {
  artifactRoot: "/unused",
  gitExecutable: "git",
  gitObjectReadTimeoutMs: 1000,
  maxBytes: 100_000,
  maxObjects: 100,
  repositoryRoots: [],
};
// The source reader is mocked at its validated filesystem boundary; no pool connections open.
function reader() {
  return createPlanningReader({
    pool,
    projectId: "project",
    config,
    source: { repositoryId: "repository", identity: "identity" },
    commitId: "a".repeat(40),
    signal: new AbortController().signal,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.coordinates.mockResolvedValue({ owner: "authorized", repository: "project" });
  mocks.identify.mockResolvedValue({
    repository: { id: "1", owner: "authorized", name: "project" },
    account: "operator",
  });
  mocks.listIssues.mockResolvedValue({
    issues: [
      {
        number: 1,
        title: "Saved reports",
        url: "https://github.com/authorized/project/issues/1",
        body: "Unneeded large body",
      },
    ],
    page: 1,
    nextPage: 2,
    limited: false,
  });
  mocks.readIssue.mockResolvedValue({ number: 1, title: "Saved reports", body: "Acceptance" });
  mocks.readIssueComments.mockResolvedValue({ comments: [], nextPage: null });
  mocks.readRepository.mockResolvedValue({ content: "Committed context", nextOffset: null });
});
it("restricts reads to the linked project and returns issue summaries before targeted details", async () => {
  const read = reader();
  const list = await read({ operation: "list_issues", page: 1 });
  expect(list).toMatchObject({ issues: [{ number: 1, title: "Saved reports" }], nextPage: 2 });
  expect(JSON.stringify(list)).not.toContain("Unneeded large body");
  expect(mocks.identify).toHaveBeenCalledWith(
    { owner: "authorized", name: "project" },
    expect.any(AbortSignal),
  );
  expect(await read({ operation: "read_issue", number: 1, page: 1 })).toMatchObject({
    issue: { body: "Acceptance" },
    comments: { comments: [], nextPage: null },
  });
});
it("rejects writes, arbitrary repositories and traversal-shaped unsupported arguments without accessing sources", async () => {
  const read = reader();
  for (const value of [
    { operation: "write_file", path: "README.md", text: "bad" },
    { operation: "read_issue", number: 1, page: 1, owner: "other" },
    { operation: "read_file", path: "x", shell: "cat x" },
  ])
    expect(await read(value)).toHaveProperty("error");
  expect(mocks.identify).not.toHaveBeenCalled();
  expect(mocks.readRepository).not.toHaveBeenCalled();
});
it("bounds the tool loop and keeps failures free of host secrets", async () => {
  const read = reader();
  mocks.readRepository.mockRejectedValueOnce(new Error("secret host path token"));
  expect(JSON.stringify(await read({ operation: "read_file", path: "README.md" }))).not.toContain(
    "secret",
  );
  for (let index = 1; index < 16; index++) await read({ operation: "find_files", query: "docs" });
  expect(JSON.stringify(await read({ operation: "find_files", query: "docs" }))).toContain(
    "budget",
  );
  expect(mocks.readRepository).toHaveBeenCalledTimes(16);
});
