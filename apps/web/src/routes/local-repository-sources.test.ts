import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiErrorSchema,
  LocalRepositoryInventorySchema,
  LocalRepositoryReferencesSchema,
} from "@kestrel/contracts";
import { LocalSourceError, type LocalSourceConfig } from "@kestrel/local-source";

import { buildApp } from "../app.js";
import {
  createCsrfToken,
  createSessionToken,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "../session.js";
import {
  createLocalRepositoryService,
  isSkippableRepositoryInspectionError,
  readAttachedLocalSourceKeys,
  type LocalRepositoryService,
} from "./local-repository-sources.js";

const signingKey = Buffer.alloc(32, 7);
const operatorId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const repositoryId = "018f0f89-9a1d-7484-b224-866ef9d69990";
const session = createSessionToken(
  { credentialVersion: "1", id: operatorId, sessionGeneration: "1", username: "operator" },
  signingKey,
).token;
const csrf = createCsrfToken(session, signingKey, Buffer.alloc(32, 3));
const headers = {
  cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`,
  host: "kestrel.test",
};

describe("local repository inventory routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const service = {
    listRepositories: vi.fn<LocalRepositoryService["listRepositories"]>(),
    listReferences: vi.fn<LocalRepositoryService["listReferences"]>(),
  };

  beforeEach(async () => {
    service.listRepositories.mockReset().mockResolvedValue({
      schemaVersion: 1,
      inventoryState: "ready",
      repositories: [{ repositoryId, displayName: "kestrel", attachmentState: "unattached" }],
    });
    service.listReferences.mockReset().mockResolvedValue({
      schemaVersion: 1,
      repositoryId,
      objectFormat: "sha1",
      references: [
        {
          ref: "refs/heads/main",
          displayName: "main",
          kind: "local_branch",
          commitObjectId: "a".repeat(40),
          commitSubjectSuggestion: "Base source",
        },
      ],
    });
    const pool = {
      query: vi.fn(() => ({
        rowCount: 1,
        rows: [
          {
            credential_version: "1",
            id: operatorId,
            jwt_signing_generation: "1",
            username: "operator",
          },
        ],
      })),
    };
    app = await buildApp({
      boss: { send: vi.fn() },
      eventRetentionLimit: 1_000,
      localRepositoryService: service,
      logger: false,
      pool: pool as never,
      sessionSigningKey: signingKey,
    });
  });

  afterEach(async () => app.close());

  it("requires authentication and returns only opaque inventory values", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/local-repository-sources" })).statusCode,
    ).toBe(401);
    const response = await app.inject({
      headers,
      method: "GET",
      url: "/api/v1/local-repository-sources",
    });
    expect(response.statusCode).toBe(200);
    const inventory = LocalRepositoryInventorySchema.parse(response.json());
    expect(inventory.inventoryState).toBe("ready");
    expect(inventory.repositories[0]).toEqual({
      repositoryId,
      displayName: "kestrel",
      attachmentState: "unattached",
    });
    expect(response.body).not.toContain("/private/");
  });

  it("distinguishes missing roots from configured roots with no repositories", async () => {
    const configuredRoot = await mkdtemp(join(tmpdir(), "kestrel-empty-repository-root-"));
    const pool = { query: vi.fn() };
    const config = (repositoryRoots: LocalSourceConfig["repositoryRoots"]): LocalSourceConfig => ({
      artifactRoot: join(tmpdir(), "kestrel-artifacts"),
      gitExecutable: "/usr/bin/git",
      gitObjectReadTimeoutMs: 1_000,
      maxBytes: 1_000,
      maxObjects: 100,
      repositoryRoots,
    });

    try {
      await expect(
        createLocalRepositoryService(config([]), pool as never).listRepositories(),
      ).resolves.toMatchObject({ inventoryState: "no_configured_roots", repositories: [] });
      await expect(
        createLocalRepositoryService(
          config([{ id: repositoryId, path: configuredRoot }]),
          pool as never,
        ).listRepositories(),
      ).resolves.toMatchObject({ inventoryState: "no_repositories_found", repositories: [] });
      expect(pool.query).not.toHaveBeenCalled();
    } finally {
      await rm(configuredRoot, { recursive: true });
    }
  });

  it("reads bounded references for one opaque repository ID", async () => {
    const response = await app.inject({
      headers,
      method: "GET",
      url: `/api/v1/local-repository-sources/${repositoryId}/references`,
    });
    expect(response.statusCode).toBe(200);
    expect(LocalRepositoryReferencesSchema.parse(response.json()).repositoryId).toBe(repositoryId);
    expect(service.listReferences).toHaveBeenCalledWith(repositoryId);
  });

  it("rejects a generic UUID that is not a Kestrel UUIDv7", async () => {
    const response = await app.inject({
      headers,
      method: "GET",
      url: "/api/v1/local-repository-sources/51cfb6e7-5310-4e71-a637-3c418cc67b86/references",
    });
    expect(response.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: "INVALID_REQUEST" });
    expect(service.listReferences).not.toHaveBeenCalled();
  });

  it("scopes attachment lookup to the bounded discovered identity pairs", async () => {
    const query = vi.fn((statement: string, parameters?: unknown[]) => {
      void statement;
      void parameters;
      return {
        rowCount: 1,
        rows: [{ repository_id: repositoryId, source_identity: "c".repeat(64) }],
      };
    });
    const keys = await readAttachedLocalSourceKeys({ query } as never, [
      { repositoryId, sourceIdentity: "c".repeat(64) },
      {
        repositoryId: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
        sourceIdentity: "d".repeat(64),
      },
    ]);

    expect(keys).toEqual(new Set([`${repositoryId}\0${"c".repeat(64)}`]));
    expect(query).toHaveBeenCalledOnce();
    const [statement, parameters] = query.mock.calls[0] ?? [];
    expect(statement).toContain("unnest($1::uuid[], $2::text[])");
    expect(statement).toContain("LIMIT $3");
    expect(parameters).toEqual([
      [repositoryId, "018f0f89-9a1e-7d64-a5dd-18cc3e317401"],
      ["c".repeat(64), "d".repeat(64)],
      2,
    ]);
  });

  it("fails startup attachment inspection closed on systemic Git failures", () => {
    expect(isSkippableRepositoryInspectionError(new LocalSourceError("repository_invalid"))).toBe(
      true,
    );
    expect(
      isSkippableRepositoryInspectionError(new LocalSourceError("git_inspection_failed")),
    ).toBe(false);
  });
});
