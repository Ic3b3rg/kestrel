import Fastify from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabasePool } from "@kestrel/database";
import { registerProjectBoardRoutes } from "./project-board.js";
import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";

const db = vi.hoisted(() => ({
  replay: vi.fn(),
  enqueue: vi.fn(),
  settings: vi.fn(),
  save: vi.fn(),
}));
const read = vi.hoisted(() => vi.fn());
vi.mock("../project-issue-reader.js", () => ({ createProjectIssueReader: () => read }));
vi.mock("@kestrel/database", async (original) => ({
  ...(await original<object>()),
  findProjectIssueStart: db.replay,
  enqueueProjectIssue: db.enqueue,
  readProjectBoardSettings: db.settings,
  saveProjectBoardSettings: db.save,
}));
const id = "01991c36-7f90-7000-8000-000000000001";
const root = `/api/v1/projects/${id}/board`;
const pool = {} as DatabasePool;
let app: ReturnType<typeof Fastify>;
let configs: unknown[];
beforeEach(() => {
  vi.resetAllMocks();
  db.replay.mockResolvedValue(null);
  db.enqueue.mockResolvedValue(id);
  db.settings.mockResolvedValue({ readyLabel: "ready-for-agent" });
  configs = [];
  app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  app.decorateRequest("operatorSession", null);
  app.addHook("onRequest", async (request) => {
    request.operatorSession = { operator: { id } } as never;
  });
  app.addHook("onRoute", (route) => {
    if (route.method === "POST") configs.push(route.config);
  });
  registerProjectBoardRoutes(app, pool);
});
afterEach(async () => app.close());

it("registers authenticated mutations and validates board settings at the HTTP boundary", async () => {
  const result = await app.inject({ method: "GET", url: `${root}/settings` });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toEqual({ readyLabel: "ready-for-agent" });
  expect(configs).toHaveLength(4);
  for (const config of configs) expect(config).toMatchObject(AUTHENTICATED_MUTATION_ROUTE_CONFIG);
  expect(
    (await app.inject({ method: "POST", url: `${root}/settings`, payload: { readyLabel: "" } }))
      .statusCode,
  ).toBe(400);
  expect(db.save).not.toHaveBeenCalled();
});

it("replays an authorized start without contacting GitHub or authorizing twice", async () => {
  db.replay.mockResolvedValue(id);
  const response = await app.inject({
    method: "POST",
    url: `${root}/start`,
    payload: { requestId: id, issueNumber: 42 },
  });
  expect(response.statusCode).toBe(202);
  expect(response.json()).toEqual({ id });
  expect(read).not.toHaveBeenCalled();
  expect(db.enqueue).not.toHaveBeenCalled();
});

it("uses a fresh issue when accepting the drop and validates paging before provider access", async () => {
  const issue = { number: 42 };
  read.mockResolvedValue({ issue });
  const response = await app.inject({
    method: "POST",
    url: `${root}/start`,
    payload: { requestId: id, issueNumber: 42 },
  });
  expect(response.statusCode).toBe(202);
  expect(read).toHaveBeenCalledWith(id, 42, 1, true);
  expect(db.enqueue).toHaveBeenCalledWith(pool, id, id, { requestId: id, issueNumber: 42 }, issue);
  read.mockClear();
  expect((await app.inject({ method: "GET", url: `${root}/issues/42?page=0` })).statusCode).toBe(
    400,
  );
  expect(read).not.toHaveBeenCalled();
});
