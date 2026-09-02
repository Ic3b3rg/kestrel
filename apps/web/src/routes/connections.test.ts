import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiErrorSchema,
  HostGitHubConnectionSchema,
  type HostGitHubConnection,
} from "@kestrel/contracts";

import { buildApp } from "../app.js";
import {
  createCsrfToken,
  createSessionToken,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "../session.js";
import {
  createHostGitHubConnectionService,
  type HostGitHubConnectionService,
} from "./connections.js";

const sessionSigningKey = Buffer.alloc(32, 7);
const operatorId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1f";
const sessionToken = createSessionToken(
  {
    credentialVersion: "1",
    id: operatorId,
    sessionGeneration: "1",
    username: "operator",
  },
  sessionSigningKey,
).token;
const csrfToken = createCsrfToken(sessionToken, sessionSigningKey, Buffer.alloc(32, 3));
const authenticatedHeaders = {
  cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`,
  host: "kestrel.test",
  origin: "https://kestrel.test",
  "x-kestrel-csrf": csrfToken,
};
const readyConnection: HostGitHubConnection = {
  schemaVersion: 1,
  state: "ready",
  reason: null,
  cli: { version: "2.87.0", supported: true },
  identity: { host: "github.com", account: "operator" },
  projectAccess: {
    state: "verified",
    projectId,
    repository: { owner: "Ic3b3rg", name: "kestrel" },
  },
  checkedAt: "2026-09-02T12:00:00.000Z",
};

describe("host GitHub Connection service", () => {
  it("derives repository coordinates from the registered Project only", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            github_name_snapshot: "kestrel",
            github_owner_snapshot: "Ic3b3rg",
            installation_id: "018f0f89-949a-75a8-8f61-6df78a843b10",
            repository_id: "018f0f89-949a-75a8-8f61-6df78a843b11",
          },
        ],
      }),
    };
    const readConnection = vi.fn().mockResolvedValue(readyConnection);
    const signal = new AbortController().signal;
    const service = createHostGitHubConnectionService(pool as never, { readConnection });

    await expect(service.read(projectId, signal)).resolves.toEqual(readyConnection);
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [projectId]);
    expect(readConnection).toHaveBeenCalledWith(
      {
        projectId,
        coordinates: { owner: "Ic3b3rg", repository: "kestrel" },
      },
      signal,
    );
  });
});

describe("host GitHub Connection route", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const read = vi.fn<HostGitHubConnectionService["read"]>();

  beforeEach(async () => {
    read.mockReset();
    read.mockResolvedValue(readyConnection);
    const pool = {
      query: vi.fn().mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            credential_version: "1",
            created_at: new Date("2026-08-24T12:00:00.000Z"),
            id: operatorId,
            jwt_signing_generation: "1",
            password_hash: "invalid-test-hash",
            username: "operator",
          },
        ],
      }),
    };
    app = await buildApp({
      boss: { send: vi.fn() },
      eventRetentionLimit: 1_000,
      hostGitHubConnectionService: { read },
      logger: false,
      pool: pool as never,
      sessionSigningKey,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("runs a fresh authenticated probe for the selected opaque Project", async () => {
    const first = await app.inject({
      headers: authenticatedHeaders,
      method: "GET",
      url: `/api/v1/connections/github?projectId=${projectId}`,
    });
    const second = await app.inject({
      headers: authenticatedHeaders,
      method: "GET",
      url: `/api/v1/connections/github?projectId=${projectId}`,
    });

    expect(first.statusCode).toBe(200);
    expect(HostGitHubConnectionSchema.parse(first.json())).toEqual(readyConnection);
    expect(second.statusCode).toBe(200);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenNthCalledWith(1, projectId, expect.any(AbortSignal));
    expect(first.headers["cache-control"]).toBe("no-store");
  });

  it("rejects unbounded query input before probing the host", async () => {
    const response = await app.inject({
      headers: authenticatedHeaders,
      method: "GET",
      url: `/api/v1/connections/github?projectId=${projectId}&projectId=${projectId}`,
    });

    expect(response.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: "INVALID_REQUEST" });
    expect(read).not.toHaveBeenCalled();
  });

  it("returns a generic error when Project lookup fails", async () => {
    read.mockRejectedValueOnce(new Error("ghp_never_expose_this"));
    const response = await app.inject({
      headers: authenticatedHeaders,
      method: "GET",
      url: `/api/v1/connections/github?projectId=${projectId}`,
    });

    expect(response.statusCode).toBe(503);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "GitHub connection verification is unavailable",
    });
    expect(response.body).not.toContain("ghp_never_expose_this");
  });

  it("requires an Operator session", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/connections/github" });

    expect(response.statusCode).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });
});
