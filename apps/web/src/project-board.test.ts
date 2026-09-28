import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabasePool } from "@kestrel/database";
import {
  ProjectBoardSnapshotSchema,
  type FactoryBoard,
  type FactoryGitHubIssue,
  type Feature,
} from "@kestrel/contracts";
import { FactoryGitHubError, type FactoryGitHubAdapter } from "./factory-github.js";
import { createProjectBoardService } from "./project-board.js";

const database = vi.hoisted(() => ({
  local: vi.fn(),
  coordinates: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  settings: vi.fn(),
  starts: vi.fn(),
}));
vi.mock("@kestrel/database", async (original) => ({
  ...(await original<object>()),
  readProjectFactoryBoards: database.local,
  readProjectGitHubCoordinates: database.coordinates,
  readProjectIssueObservation: database.read,
  saveProjectIssueObservation: database.save,
  readProjectBoardSettings: database.settings,
  readProjectIssueStarts: database.starts,
}));
const projectId = "01991c36-7f90-7000-8000-000000000001";
const at = "2026-09-23T12:00:00.000Z";
const feature: Feature = {
  schemaVersion: 1,
  id: "01991c36-7f90-7000-8000-000000000002",
  projectId,
  title: "Export reports",
  state: "planning",
  createdAt: at,
  updatedAt: at,
};
const repository = { id: "901", owner: "example", name: "reports" };
const issue: FactoryGitHubIssue = {
  repository,
  id: "42",
  number: 42,
  url: "https://github.com/example/reports/issues/42",
  title: "Export reports",
  body: "Untrusted provider context",
  state: "open",
  dependencies: [],
};
const readCatalog = vi.fn<FactoryGitHubAdapter["readIssueCatalog"]>();
const github = { readIssueCatalog: readCatalog } as unknown as FactoryGitHubAdapter;
const pool = {} as DatabasePool;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  database.local.mockReset().mockResolvedValue({ projectId, features: [feature], boards: [] });
  database.coordinates.mockReset().mockResolvedValue({ owner: "example", repository: "reports" });
  const observations = new Map<string, unknown>();
  database.read
    .mockReset()
    .mockImplementation((_pool: unknown, _project: unknown, key: string) =>
      Promise.resolve(observations.get(key) ?? null),
    );
  database.save
    .mockReset()
    .mockImplementation((_pool: unknown, _project: unknown, key: string, value: unknown) => {
      observations.set(key, value);
      return Promise.resolve();
    });
  database.settings.mockReset().mockResolvedValue({ readyLabel: "ready-for-agent" });
  database.starts.mockReset().mockResolvedValue([]);
  readCatalog.mockReset().mockResolvedValue({ issues: [issue], limited: false, failure: null });
});
afterEach(() => vi.useRealTimers());

it("coalesces concurrent reads so an older response cannot overwrite a newer catalog", async () => {
  const pending =
    Promise.withResolvers<Awaited<ReturnType<FactoryGitHubAdapter["readIssueCatalog"]>>>();
  readCatalog.mockReturnValueOnce(pending.promise);
  const service = createProjectBoardService(pool, github);
  const signal = new AbortController().signal;
  const first = service.read(projectId, signal);
  const second = service.read(projectId, signal);
  await vi.advanceTimersByTimeAsync(0);
  expect(readCatalog).toHaveBeenCalledOnce();
  pending.resolve({ issues: [issue], limited: false, failure: null });
  expect((await first).github).toEqual((await second).github);
});

it("joins local cards with one bounded, deduplicated provider catalog", async () => {
  readCatalog.mockResolvedValueOnce({ issues: [issue, issue], limited: false, failure: null });
  const result = await createProjectBoardService(pool, github).read(
    projectId,
    new AbortController().signal,
  );
  expect(result.planningFeatures).toEqual([feature]);
  expect(result.github.issues).toEqual([expect.objectContaining({ id: issue.id })]);
  expect(result.github).toMatchObject({ failure: null, checkedAt: at, retained: false });
  expect(readCatalog).toHaveBeenCalledOnce();
});

it("uses approved state and suppresses provider cards already linked to Work Items", async () => {
  const board: FactoryBoard = {
    schemaVersion: 1,
    feature: { ...feature, state: "implementing" },
    approvedVersion: 1,
    executionReadiness: { state: "enabled", reason: "automatic_execution" },
    activity: [],
    columns: [
      {
        id: "in_review",
        items: [
          {
            id: "01991c36-7f90-7000-8000-000000000003",
            featureId: feature.id,
            key: "export",
            order: 1,
            title: "Export reports",
            description: "Export saved reports",
            importedIssueId: null,
            requirementKeys: ["export"],
            acceptance: ["Reports export"],
            dependsOn: [],
            verification: [],
            column: "in_review",
            blocking: null,
            providerUrl: issue.url,
            activity: [],
          },
        ],
      },
    ],
  };
  database.local.mockResolvedValue({ projectId, features: [feature], boards: [board] });
  const result = await createProjectBoardService(pool, github).read(
    projectId,
    new AbortController().signal,
  );
  expect(result.planningFeatures).toEqual([]);
  expect(result.workItems).toHaveLength(1);
  expect(result.workItems[0]).toMatchObject({
    feature: { id: feature.id },
    item: { column: "in_review" },
  });
  expect(result.github.issues).toEqual([]);
});

it("refreshes local facts on every read without polling GitHub every two seconds", async () => {
  const service = createProjectBoardService(pool, github);
  const signal = new AbortController().signal;
  await service.read(projectId, signal);
  vi.advanceTimersByTime(2_000);
  await service.read(projectId, signal);
  expect(database.local).toHaveBeenCalledTimes(2);
  expect(readCatalog).toHaveBeenCalledOnce();
  await service.read(projectId, signal, true);
  expect(readCatalog).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(60_000);
  await service.read(projectId, signal);
  expect(readCatalog).toHaveBeenCalledTimes(3);
});

it("keeps local work and the last provider read when refresh fails", async () => {
  const service = createProjectBoardService(pool, github);
  const signal = new AbortController().signal;
  await service.read(projectId, signal);
  readCatalog.mockRejectedValueOnce(new FactoryGitHubError("rate_limited"));
  const result = await service.read(projectId, signal, true);
  expect(result.planningFeatures).toEqual([feature]);
  expect(result.github).toMatchObject({
    failure: "rate_limited",
    retained: true,
    issues: [expect.objectContaining({ id: "42" })],
  });
});

it("returns local work and partial pages if the first catalog read fails midway", async () => {
  readCatalog.mockResolvedValueOnce({ issues: [issue], limited: true, failure: "unavailable" });
  const result = await createProjectBoardService(pool, github).read(
    projectId,
    new AbortController().signal,
  );
  expect(result.planningFeatures).toHaveLength(1);
  expect(result.github).toMatchObject({
    failure: "unavailable",
    limited: true,
    issues: [expect.objectContaining({ id: "42" })],
  });
});

it("bounds a stalled provider and still returns local work", async () => {
  readCatalog.mockReturnValue(new Promise(() => undefined));
  const result = createProjectBoardService(pool, github).read(
    projectId,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await result).github.failure).toBe("timeout");
});

it("cancels navigation reads while retaining a shared refresh for subsequent visits", async () => {
  const pending =
    Promise.withResolvers<Awaited<ReturnType<FactoryGitHubAdapter["readIssueCatalog"]>>>();
  readCatalog.mockReturnValueOnce(pending.promise);
  const service = createProjectBoardService(pool, github);
  const controller = new AbortController();
  const result = service.read(projectId, controller.signal);
  const rejected = expect(result).rejects.toMatchObject({ failure: "cancelled" });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await rejected;
  pending.resolve({ issues: [issue], limited: false, failure: null });
  const next = await service.read(projectId, new AbortController().signal);
  expect(next.github.issues).toHaveLength(1);
});

it("returns a persisted catalog after restart while one stale refresh runs in the background", async () => {
  const signal = new AbortController().signal;
  await createProjectBoardService(pool, github).read(projectId, signal);
  expect(database.save).toHaveBeenCalledOnce();
  ProjectBoardSnapshotSchema.shape.github.parse(database.save.mock.calls[0]?.[3]);
  vi.advanceTimersByTime(61_000);
  const pending =
    Promise.withResolvers<Awaited<ReturnType<FactoryGitHubAdapter["readIssueCatalog"]>>>();
  readCatalog.mockReturnValueOnce(pending.promise);
  const restarted = createProjectBoardService(pool, github);
  const [first, second] = await Promise.all([
    restarted.read(projectId, signal),
    restarted.read(projectId, signal),
  ]);
  expect(first.github.issues).toHaveLength(1);
  expect(second.github.fetchedAt).toBe(at);
  expect(readCatalog).toHaveBeenCalledTimes(2);
  pending.resolve({ issues: [], limited: false, failure: null });
  await vi.advanceTimersByTimeAsync(0);
  expect((await restarted.read(projectId, signal)).github.issues).toEqual([]);
});

it("honors a rate-limit deadline even across restart and manual refresh", async () => {
  const signal = new AbortController().signal;
  const retryAt = "2026-09-23T13:00:00.000Z";
  const service = createProjectBoardService(pool, github);
  await service.read(projectId, signal);
  readCatalog.mockResolvedValueOnce({
    issues: [],
    limited: true,
    failure: "rate_limited",
    retryAt,
  });
  await service.read(projectId, signal, true);
  vi.advanceTimersByTime(61_000);
  expect(
    (await createProjectBoardService(pool, github).read(projectId, signal, true)).github,
  ).toMatchObject({ retryAt, retained: true });
  expect(readCatalog).toHaveBeenCalledTimes(2);
});
