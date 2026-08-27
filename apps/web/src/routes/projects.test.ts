import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiErrorSchema,
  ProjectInboxSchema,
  ProjectUpsertedSchema,
  type Project,
} from "@kestrel/contracts";

import { buildApp } from "../app.js";
import {
  createCsrfToken,
  createSessionToken,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "../session.js";
import { PublicGitHubReadError, type PublicGitHubReader } from "../public-github.js";
import {
  createProjectService,
  type HostGitHubProjectService,
  type ProjectService,
  type ProjectStore,
} from "./projects.js";

const sessionSigningKey = Buffer.alloc(32, 7);
const operatorId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
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

const project: Project = {
  changeProposals: [
    {
      author: { login: "octocat", providerId: "U_kgDOA" },
      base: { objectId: "a".repeat(40), ref: "main" },
      canonicalUrl: "https://github.com/openai/openai-node/pull/1234",
      changeIntent: null,
      head: { objectId: "b".repeat(40), ref: "provider-observation" },
      id: "018f0f89-9192-755f-aa96-f72094c734dd",
      kind: "provider_observed",
      number: 1234,
      observedAt: "2026-08-24T12:01:00.000Z",
      proposalState: "open",
      providerId: "PR_kwDOGx",
      reviewRevisions: [],
      title: "Keep repository access explicit",
    },
  ],
  createdAt: "2026-08-24T12:00:00.000Z",
  id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
  localRepositorySource: null,
  modelAccess: "not_configured",
  providerObservation: {
    authentication: "none",
    kind: "public_github",
    refresh: "manual",
  },
  repository: {
    canonicalUrl: "https://github.com/openai/openai-node",
    name: "openai-node",
    owner: "openai",
    providerId: "R_kgDOGx",
  },
  sourceAvailability: "not_acquired",
  updatedAt: "2026-08-24T12:01:00.000Z",
};

describe("Project service", () => {
  it("does not touch storage when the public read fails", async () => {
    const read = vi.fn<PublicGitHubReader["read"]>();
    const upsert = vi.fn<ProjectStore["upsert"]>();
    read.mockRejectedValue(new PublicGitHubReadError("not_found"));
    const service = createProjectService(
      { read },
      {
        readInbox: vi.fn<ProjectStore["readInbox"]>(),
        upsert,
      },
    );

    await expect(
      service.openPublicGitHubPullRequest(
        { url: "https://github.com/openai/openai-node/pull/1234" },
        { actorId: operatorId, correlationId: "018f0f89-949a-75a8-8f61-6df78a843b1f" },
      ),
    ).rejects.toMatchObject({ kind: "not_found" });
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("Project routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const projectService: {
    openPublicGitHubPullRequest: ReturnType<
      typeof vi.fn<ProjectService["openPublicGitHubPullRequest"]>
    >;
    readInbox: ReturnType<typeof vi.fn<ProjectService["readInbox"]>>;
  } = {
    openPublicGitHubPullRequest: vi.fn<ProjectService["openPublicGitHubPullRequest"]>(),
    readInbox: vi.fn<ProjectService["readInbox"]>(),
  };
  const hostGitHubProjectService = {
    read: vi.fn<HostGitHubProjectService["read"]>(),
    observe: vi.fn<HostGitHubProjectService["observe"]>(),
  };

  beforeEach(async () => {
    projectService.openPublicGitHubPullRequest.mockReset();
    projectService.readInbox.mockReset();
    projectService.readInbox.mockResolvedValue({ schemaVersion: 1, projects: [project] });
    projectService.openPublicGitHubPullRequest.mockResolvedValue({ schemaVersion: 1, project });
    hostGitHubProjectService.read.mockReset();
    hostGitHubProjectService.observe.mockReset();
    hostGitHubProjectService.read.mockResolvedValue({
      schemaVersion: 1,
      projectId: project.id,
      route: "host_gh",
      limitations: ["Manual refresh only"],
      status: {
        executableVersion: "2.87.0",
        availability: "available",
        host: "github.com",
        authentication: "authenticated",
        account: "operator",
      },
      pullRequests: [],
      observedAt: "2026-08-27T10:00:00.000Z",
    });
    hostGitHubProjectService.observe.mockResolvedValue({ schemaVersion: 1, project });
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
      logger: false,
      hostGitHubProjectService,
      pool: pool as never,
      projectService,
      sessionSigningKey,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("reads the authenticated Project inbox", async () => {
    const response = await app.inject({
      headers: authenticatedHeaders,
      method: "GET",
      url: "/api/v1/projects",
    });

    expect(response.statusCode).toBe(200);
    expect(ProjectInboxSchema.parse(response.json())).toEqual({
      schemaVersion: 1,
      projects: [project],
    });
  });

  it("reads the attributed host GitHub route for one Project", async () => {
    const response = await app.inject({
      headers: authenticatedHeaders,
      method: "GET",
      url: `/api/v1/projects/${project.id}/provider/github?refresh=true`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      projectId: project.id,
      route: "host_gh",
      status: { account: "operator", host: "github.com" },
    });
    expect(hostGitHubProjectService.read).toHaveBeenCalledWith(
      project.id,
      true,
      expect.any(AbortSignal),
    );
  });

  it("selects one host pull request without accepting repository coordinates", async () => {
    const response = await app.inject({
      headers: { ...authenticatedHeaders, "content-type": "application/json" },
      method: "POST",
      payload: { number: 1234 },
      url: `/api/v1/projects/${project.id}/provider/github/pull-requests/observe`,
    });

    expect(response.statusCode).toBe(200);
    expect(hostGitHubProjectService.observe).toHaveBeenCalledWith(
      project.id,
      1234,
      expect.objectContaining({ actorId: operatorId }),
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(hostGitHubProjectService.observe.mock.calls[0])).not.toContain(
      "openai-node",
    );
  });

  it("fails closed when Project storage cannot be read", async () => {
    projectService.readInbox.mockRejectedValueOnce(new Error("database detail"));

    const response = await app.inject({
      headers: authenticatedHeaders,
      method: "GET",
      url: "/api/v1/projects",
    });

    expect(response.statusCode).toBe(503);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Project storage is unavailable",
    });
    expect(response.body).not.toContain("database detail");
  });

  it("opens or refreshes the canonical URL for the current Operator", async () => {
    const response = await app.inject({
      headers: { ...authenticatedHeaders, "content-type": "application/json" },
      method: "POST",
      payload: { url: "https://github.com/openai/openai-node/pull/1234" },
      url: "/api/v1/projects",
    });

    expect(response.statusCode).toBe(200);
    expect(ProjectUpsertedSchema.parse(response.json())).toEqual({ schemaVersion: 1, project });
    const invocation = projectService.openPublicGitHubPullRequest.mock.calls[0];
    expect(invocation?.[0]).toEqual({
      url: "https://github.com/openai/openai-node/pull/1234",
    });
    expect(invocation?.[1].actorId).toBe(operatorId);
    expect(invocation?.[1].correlationId).toMatch(/^[a-f0-9-]{36}$/u);
  });

  it("rejects a non-canonical URL before invoking the service", async () => {
    const response = await app.inject({
      headers: { ...authenticatedHeaders, "content-type": "application/json" },
      method: "POST",
      payload: { url: "http://127.0.0.1/internal" },
      url: "/api/v1/projects",
    });

    expect(response.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: "INVALID_REQUEST" });
    expect(projectService.openPublicGitHubPullRequest).not.toHaveBeenCalled();
  });

  it.each([
    [new PublicGitHubReadError("redirected"), 400, "INVALID_REQUEST"],
    [new PublicGitHubReadError("not_found"), 404, "NOT_FOUND"],
    [new PublicGitHubReadError("rate_limited", "1787673600"), 429, "RATE_LIMITED"],
    [new PublicGitHubReadError("invalid_response"), 503, "SERVICE_UNAVAILABLE"],
    [new PublicGitHubReadError("unavailable"), 503, "SERVICE_UNAVAILABLE"],
  ] as const)("maps a provider failure without exposing it", async (error, status, code) => {
    projectService.openPublicGitHubPullRequest.mockRejectedValueOnce(error);

    const response = await app.inject({
      headers: { ...authenticatedHeaders, "content-type": "application/json" },
      method: "POST",
      payload: { url: "https://github.com/openai/openai-node/pull/1234" },
      url: "/api/v1/projects",
    });

    expect(response.statusCode).toBe(status);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code });
  });
});
