import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiErrorSchema,
  ChangeIntentVersionCreatedSchema,
  type ChangeIntentVersionCreated,
} from "@kestrel/contracts";
import { ChangeIntentPersistenceError } from "@kestrel/database";

import { buildApp } from "../app.js";
import {
  createCsrfToken,
  createSessionToken,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "../session.js";
import type { ChangeIntentService } from "./change-intents.js";

const sessionSigningKey = Buffer.alloc(32, 7);
const operatorId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const projectId = "018f0f89-a21d-7e31-8d27-aa4383f22991";
const changeProposalId = "018f0f89-a3fb-75ee-bccc-08c031ce5f10";
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
const headers = {
  cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`,
  host: "kestrel.test",
  origin: "https://kestrel.test",
  "content-type": "application/json",
  "x-kestrel-csrf": csrfToken,
};
const command = {
  acceptanceOutcomes: ["Provider metadata remains optional context."],
  expectedProposalVersion: 3,
  objective: "Keep repository access explicit and read-only.",
  operatorInput: "Focus the review on the local authorization boundary.",
  scopeBoundaries: ["Do not add provider write authority."],
  selectedSourceIds: ["provider_title", "head_commit_message"],
  unresolvedIssues: [],
} as const;
const created: ChangeIntentVersionCreated = {
  schemaVersion: 1,
  projectId,
  changeProposalId,
  proposalVersion: 4,
  changeIntent: {
    acceptanceOutcomes: [...command.acceptanceOutcomes],
    createdAt: "2026-08-24T12:02:00.000Z",
    id: "018f0f89-9a20-79f9-9990-dda80c9b917e",
    objective: command.objective,
    resolution: { state: "resolved", issues: [] },
    scopeBoundaries: [...command.scopeBoundaries],
    sourceDigest: "a".repeat(64),
    sources: [
      {
        id: "provider_title",
        kind: "provider_field",
        label: "GitHub title",
        text: "Keep repository access explicit",
        version: "2026-08-24T12:01:00.000Z",
        provenance: {
          canonicalUrl: "https://github.com/openai/openai-node/pull/1234",
          field: "title",
          kind: "provider_field",
          observedAt: "2026-08-24T12:01:00.000Z",
          provider: "github",
        },
      },
    ],
    text: command.objective,
    version: 2,
  },
};

describe("Change Intent routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const service = {
    createVersion: vi.fn<ChangeIntentService["createVersion"]>(),
  };

  beforeEach(async () => {
    service.createVersion.mockReset();
    service.createVersion.mockResolvedValue(created);
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
      changeIntentService: service,
      eventRetentionLimit: 1_000,
      logger: false,
      pool: pool as never,
      sessionSigningKey,
    });
  });

  afterEach(async () => app.close());

  it("creates one immutable version from opaque selected source IDs", async () => {
    const response = await app.inject({
      headers,
      method: "POST",
      payload: command,
      url: `/api/v1/projects/${projectId}/change-proposals/${changeProposalId}/change-intents`,
    });

    expect(response.statusCode).toBe(201);
    expect(ChangeIntentVersionCreatedSchema.parse(response.json())).toEqual(created);
    expect(service.createVersion).toHaveBeenCalledWith(command, {
      actorId: operatorId,
      changeProposalId,
      correlationId: expect.any(String),
      projectId,
    });
  });

  it("rejects forged source snapshots before invoking persistence", async () => {
    const response = await app.inject({
      headers,
      method: "POST",
      payload: { ...command, selectedSources: created.changeIntent.sources },
      url: `/api/v1/projects/${projectId}/change-proposals/${changeProposalId}/change-intents`,
    });

    expect(response.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: "INVALID_REQUEST" });
    expect(service.createVersion).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", 404, "NOT_FOUND"],
    ["source_conflict", 409, "CHANGE_INTENT_SOURCE_CONFLICT"],
    ["version_conflict", 409, "CHANGE_PROPOSAL_VERSION_CONFLICT"],
  ] as const)("maps the %s persistence conflict", async (kind, status, code) => {
    service.createVersion.mockRejectedValueOnce(new ChangeIntentPersistenceError(kind));

    const response = await app.inject({
      headers,
      method: "POST",
      payload: command,
      url: `/api/v1/projects/${projectId}/change-proposals/${changeProposalId}/change-intents`,
    });

    expect(response.statusCode).toBe(status);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code });
  });
});
