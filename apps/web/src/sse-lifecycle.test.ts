import { EventEmitter, once } from "node:events";
import { randomUUID } from "node:crypto";
import { get, type ClientRequest, type IncomingMessage } from "node:http";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, expect, it, vi } from "vitest";

import { registerAuthentication } from "./authentication.js";
import { registerEventRoutes } from "./routes/events.js";
import { createSessionToken, SESSION_COOKIE_NAME } from "./session.js";

const signingKey = Buffer.alloc(32, 7);
const operator = {
  credentialVersion: "1",
  id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
  sessionGeneration: "1",
  username: "operator",
};
const apps: FastifyInstance[] = [];
const requests: ClientRequest[] = [];

function query(statement: string): Promise<{ rowCount: number; rows: Record<string, unknown>[] }> {
  if (statement.includes("FROM operators")) {
    return Promise.resolve({
      rowCount: 1,
      rows: [
        {
          credential_version: "1",
          created_at: new Date("2026-08-24T12:00:00.000Z"),
          id: operator.id,
          jwt_signing_generation: "1",
          password_hash: "fixture-only",
          username: operator.username,
        },
      ],
    });
  }
  return Promise.resolve({
    rowCount: 1,
    rows: [
      {
        id: null,
        first_available_event_id: "1",
        latest_event_id: "0",
        retention_floor_event_id: "0",
      },
    ],
  });
}

async function fixture() {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(query),
    release: vi.fn(),
  });
  const pool = { connect: vi.fn(() => Promise.resolve(client)), query: vi.fn(query) };
  const app = Fastify({ logger: false, genReqId: () => randomUUID() });
  const responseClosed = Promise.withResolvers<undefined>();
  apps.push(app);
  app.addHook("onRequest", (_request, reply, done) => {
    reply.raw.once("close", responseClosed.resolve);
    done();
  });
  registerAuthentication(app, { query } as never, signingKey);
  registerEventRoutes(app, pool as never);
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, client, pool, url, responseClosed: responseClosed.promise };
}

function open(url: string) {
  const request = get(`${url}/api/v1/events`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken(operator, signingKey).token}` },
  });
  requests.push(request);
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    request.once("response", (incoming) => {
      incoming.on("error", () => undefined);
      resolve(incoming);
    });
    request.once("error", reject);
  });
  void response.catch(() => undefined);
  return response;
}

async function closesPromptly(app: FastifyInstance) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      app.close().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(async () => {
  for (const request of requests.splice(0)) request.destroy();
  for (const app of apps.splice(0)) await app.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("closes the application with an authenticated SSE stream still connected", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { app, client, url } = await fixture();
  const response = await open(url);
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
  const chunk: unknown = (await once(response, "data"))[0];
  expect(String(chunk)).toBe(": connected\n\n");
  const closed = new Promise<void>((resolve) => response.once("close", resolve));
  expect(vi.getTimerCount()).toBe(2);

  expect(await closesPromptly(app)).toBe(true);
  await closed;
  expect(client.release).toHaveBeenCalledOnce();
  expect(client.listenerCount("notification")).toBe(0);
  expect(client.listenerCount("error")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("closes during listener acquisition and discards the client if it arrives after shutdown", async () => {
  const { app, client, pool, url } = await fixture();
  const entered = Promise.withResolvers<undefined>();
  const connection = Promise.withResolvers<typeof client>();
  pool.connect.mockImplementation(() => {
    entered.resolve(undefined);
    return connection.promise;
  });
  const response = open(url).catch(() => null);
  await entered.promise;
  const closed = await closesPromptly(app);
  connection.resolve(client);
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(closed).toBe(true);
  expect((await response) === null).toBe(true);
  expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  expect(client.query).not.toHaveBeenCalled();
  expect(client.listenerCount("notification")).toBe(0);
});

it("closes during initial cursor validation without starting a listener afterwards", async () => {
  const { app, pool, url } = await fixture();
  const entered = Promise.withResolvers<undefined>();
  const validation = Promise.withResolvers<Awaited<ReturnType<typeof query>>>();
  pool.query.mockImplementation((statement) => {
    entered.resolve(undefined);
    return validation.promise.then(() => query(statement));
  });
  const response = open(url).catch(() => null);
  await entered.promise;
  const closed = await closesPromptly(app);
  validation.resolve(await query("metadata"));
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(closed).toBe(true);
  expect((await response) === null).toBe(true);
  expect(pool.connect).not.toHaveBeenCalled();
});

it("discards a listener acquired after the HTTP client already disconnected", async () => {
  const { app, client, pool, url, responseClosed } = await fixture();
  const entered = Promise.withResolvers<undefined>();
  const connection = Promise.withResolvers<typeof client>();
  pool.connect.mockImplementation(() => {
    entered.resolve(undefined);
    return connection.promise;
  });
  const response = open(url).catch(() => null);
  await entered.promise;
  requests.at(-1)?.destroy();
  await response;
  await responseClosed;
  connection.resolve(client);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  expect(client.query).not.toHaveBeenCalled();
  expect(await closesPromptly(app)).toBe(true);
});

it.each(["listen", "validation", "drain"])(
  "destroys the dedicated client during a pending %s query without waiting for its result",
  async (stage) => {
    const { app, client, url } = await fixture();
    const entered = Promise.withResolvers<undefined>();
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof query>>>();
    client.query.mockImplementation((statement) => {
      const selected =
        stage === "listen"
          ? statement === "LISTEN kestrel_events"
          : stage === "validation"
            ? statement.includes("FROM event_streams")
            : statement.includes("FROM operators");
      if (selected) {
        entered.resolve(undefined);
        return pending.promise;
      }
      return query(statement);
    });
    void open(url)
      .then((response) => response.resume())
      .catch(() => undefined);
    await entered.promise;
    expect(await closesPromptly(app)).toBe(true);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.listenerCount("notification")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
    const calls = client.query.mock.calls.length;
    pending.reject(new Error("Fixture connection destroyed during query"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(client.query).toHaveBeenCalledTimes(calls);
  },
);

it("preserves authentication and cursor rejection before establishing the stream", async () => {
  const { app, client, pool, url } = await fixture();
  const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken(operator, signingKey).token}`;
  const anonymous = await fetch(`${url}/api/v1/events`);
  expect(anonymous.status).toBe(401);
  await anonymous.text();
  const malformed = await fetch(`${url}/api/v1/events?after=invalid`, { headers: { cookie } });
  expect(malformed.status).toBe(400);
  await malformed.text();
  const expired = {
    rowCount: 1,
    rows: [
      {
        id: null,
        first_available_event_id: "6",
        latest_event_id: "10",
        retention_floor_event_id: "5",
      },
    ],
  };
  pool.query.mockResolvedValueOnce(expired);
  const initial = await fetch(`${url}/api/v1/events`, { headers: { cookie } });
  expect(initial.status).toBe(409);
  expect(await initial.json()).toMatchObject({
    code: "EVENT_CURSOR_EXPIRED",
    firstAvailableEventId: "6",
  });
  expect(pool.connect).not.toHaveBeenCalled();

  client.query.mockImplementation((statement) =>
    statement.includes("FROM event_streams") ? Promise.resolve(expired) : query(statement),
  );
  const changed = await fetch(`${url}/api/v1/events`, { headers: { cookie } });
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({
    code: "EVENT_CURSOR_EXPIRED",
    firstAvailableEventId: "6",
  });
  expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  expect(await closesPromptly(app)).toBe(true);
});

it.each(["cursor", "session"])(
  "finishes the established stream when its %s is invalidated",
  async (reason) => {
    const { app, client, url } = await fixture();
    client.query.mockImplementation(async (statement) => {
      if (reason === "cursor" && statement.includes("LEFT JOIN LATERAL")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: null,
              first_available_event_id: "6",
              latest_event_id: "10",
              retention_floor_event_id: "5",
            },
          ],
        };
      }
      if (reason === "session" && statement.includes("FROM operators")) {
        return { rowCount: 0, rows: [] };
      }
      return query(statement);
    });
    const response = await open(url);
    let body = "";
    for await (const chunk of response) body += String(chunk);
    expect(response.statusCode).toBe(200);
    expect(body).toContain(": connected\n\n");
    if (reason === "cursor") {
      expect(body).toContain("event: reset-required\n");
      expect(body).toContain('"firstAvailableEventId":"6"');
    }
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.listenerCount("notification")).toBe(0);
    expect(await closesPromptly(app)).toBe(true);
  },
);
