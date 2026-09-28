import { beforeEach, expect, it, vi } from "vitest";
import type { DatabasePool } from "@kestrel/database";
import { createProjectIssueReader } from "./project-issue-reader.js";
import { FactoryGitHubError, type FactoryGitHubAdapter } from "./factory-github.js";
const db = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock("@kestrel/database", async (original) => ({
  ...(await original<object>()),
  boardProjectId: () => Promise.resolve("project"),
  readProjectGitHubCoordinates: () => Promise.resolve({ owner: "example", repository: "reports" }),
  readProjectIssueObservation: db.read,
  saveProjectIssueObservation: db.save,
}));
beforeEach(() => {
  const values = new Map<string, unknown>();
  db.read
    .mockReset()
    .mockImplementation((_pool: unknown, _project: unknown, key: string) =>
      Promise.resolve(values.get(key) ?? null),
    );
  db.save
    .mockReset()
    .mockImplementation((_pool: unknown, _project: unknown, key: string, value: unknown) =>
      Promise.resolve(values.set(key, value)),
    );
});
it("persists a provider throttle deadline even with no previous issue to display", async () => {
  const identify = vi
    .fn()
    .mockRejectedValue(
      new FactoryGitHubError("rate_limited", new Date(Date.now() + 3600000).toISOString()),
    );
  const adapter = { identify } as unknown as FactoryGitHubAdapter;
  const pool = {} as DatabasePool;
  await expect(
    createProjectIssueReader(pool, adapter)("project", 42, 1, true),
  ).rejects.toMatchObject({ failure: "rate_limited" });
  await expect(
    createProjectIssueReader(pool, adapter)("project", 42, 1, true),
  ).rejects.toMatchObject({ failure: "rate_limited" });
  expect(identify).toHaveBeenCalledOnce();
});

it("shows saved content immediately and exposes a completed refresh without repeating GitHub calls", async () => {
  const previous = {
    issue: {
      repository: { id: "1", owner: "example", name: "reports" },
      id: "2",
      number: 42,
      url: "https://github.com/example/reports/issues/42",
      title: "Old",
      body: "Saved",
      state: "open",
      dependencies: [],
    },
    comments: [],
    nextPage: null,
    fetchedAt: new Date(Date.now() - 120000).toISOString(),
    failure: null,
  };
  await db.save({}, "project", "discussion:example/reports:42:1", previous);
  let complete!: (value: unknown) => void;
  const discussion = new Promise((resolve) => {
    complete = resolve;
  });
  const readDiscussion = vi.fn().mockReturnValue(discussion);
  const adapter = {
    identify: vi.fn().mockResolvedValue({}),
    readIssueDiscussion: readDiscussion,
  } as unknown as FactoryGitHubAdapter;
  const read = createProjectIssueReader({} as DatabasePool, adapter);
  expect(await read("project", 42)).toMatchObject({ refreshing: true, issue: { title: "Old" } });
  complete({ ...previous, issue: { ...previous.issue, title: "Current" } });
  await vi.waitFor(() =>
    expect(db.save).toHaveBeenCalledWith(
      expect.anything(),
      "project",
      "discussion:example/reports:42:1",
      expect.objectContaining({ issue: expect.objectContaining({ title: "Current" }) as unknown }),
    ),
  );
  expect(await read("project", 42)).toMatchObject({ issue: { title: "Current" } });
  expect(readDiscussion).toHaveBeenCalledOnce();
});
