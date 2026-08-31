import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiErrorSchema, type Project, type ReviewRevisionAvailable } from "@kestrel/contracts";

import { buildApp } from "../app.js";
import {
  createCsrfToken,
  createSessionToken,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "../session.js";
import {
  buildReviewRevisionResponse,
  recoverCompletionFailure,
  resolveObservedReviewRevisionSelection,
  type ReviewRevisionService,
} from "./review-revisions.js";

const signingKey = Buffer.alloc(32, 7);
const operatorId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const repositoryId = "018f0f89-9a1d-7484-b224-866ef9d69990";
const projectId = "018f0f89-9a22-7864-aac2-8df71bf60420";
const proposalId = "018f0f89-9192-755f-aa96-f72094c734dd";
const session = createSessionToken(
  { credentialVersion: "1", id: operatorId, sessionGeneration: "1", username: "operator" },
  signingKey,
).token;
const csrf = createCsrfToken(session, signingKey, Buffer.alloc(32, 3));
const headers = {
  cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`,
  host: "kestrel.test",
  origin: "https://kestrel.test",
  "x-kestrel-csrf": csrf,
  "content-type": "application/json",
};

describe("Review Revision route", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const retain = vi.fn<ReviewRevisionService["retain"]>();

  beforeEach(async () => {
    retain.mockReset().mockRejectedValue(new Error("not configured"));
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
      logger: false,
      pool: pool as never,
      reviewRevisionService: { retain },
      sessionSigningKey: signingKey,
    });
  });

  afterEach(async () => app.close());

  it("rejects filesystem paths before invoking acquisition", async () => {
    const response = await app.inject({
      headers,
      method: "POST",
      payload: {
        repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/topic",
        changeIntent: "Review authorization boundaries",
        path: "/private/repository",
      },
      url: "/api/v1/review-revisions",
    });
    expect(response.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: "INVALID_REQUEST" });
    expect(retain).not.toHaveBeenCalled();
  });

  it("rejects an identical base and head before invoking acquisition", async () => {
    const response = await app.inject({
      headers,
      method: "POST",
      payload: {
        repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/main",
        changeIntent: "Review authorization boundaries",
      },
      url: "/api/v1/review-revisions",
    });
    expect(response.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: "INVALID_REQUEST" });
    expect(retain).not.toHaveBeenCalled();
  });

  it("requires same-origin CSRF protection before acquisition", async () => {
    const response = await app.inject({
      headers: { cookie: headers.cookie, host: headers.host, "content-type": "application/json" },
      method: "POST",
      payload: {
        repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/topic",
        changeIntent: "Review authorization boundaries",
      },
      url: "/api/v1/review-revisions",
    });
    expect(response.statusCode).toBe(403);
    expect(retain).not.toHaveBeenCalled();
  });

  it("accepts the worst-case serialized form of a schema-valid Change Intent", async () => {
    const response = await app.inject({
      headers,
      method: "POST",
      payload: {
        repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/topic",
        changeIntent: "\\".repeat(20_000),
      },
      url: "/api/v1/review-revisions",
    });

    expect(response.statusCode).toBe(503);
    expect(retain).toHaveBeenCalledOnce();
  });

  it("accepts an opaque observed-PR command and propagates request cancellation", async () => {
    const command = {
      projectId,
      changeProposalId: proposalId,
      changeIntent: "Review the exact observed pull request",
    };
    const response = await app.inject({
      headers,
      method: "POST",
      payload: command,
      url: "/api/v1/review-revisions",
    });

    expect(response.statusCode).toBe(503);
    expect(retain).toHaveBeenCalledOnce();
    const call = retain.mock.calls[0];
    if (call === undefined) throw new Error("Review Revision retention was not invoked");
    expect(call[0]).toEqual(command);
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("maps an acquiring conflict without exposing local details", async () => {
    const error = new Error("/private/repository is acquiring") as Error & { code: string };
    error.code = "revision_acquiring";
    retain.mockRejectedValueOnce(error);
    const response = await app.inject({
      headers,
      method: "POST",
      payload: {
        repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/topic",
        changeIntent: "Review authorization boundaries",
      },
      url: "/api/v1/review-revisions",
    });
    expect(response.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: "REVISION_ACQUIRING" });
    expect(response.body).not.toContain("/private/repository");
  });

  it.each([
    ["base_revision_unresolvable", 404, "BASE_REVISION_UNRESOLVABLE"],
    ["head_revision_unresolvable", 404, "HEAD_REVISION_UNRESOLVABLE"],
    ["pull_ref_mismatch", 409, "PULL_REF_MISMATCH"],
    ["provider_authentication_required", 503, "PROVIDER_AUTHENTICATION_REQUIRED"],
    ["provider_resource_unavailable", 503, "PROVIDER_RESOURCE_UNAVAILABLE"],
  ])("maps %s to a distinct safe response", async (errorCode, statusCode, apiCode) => {
    const error = new Error(`/private/repository: provider stderr`) as Error & { code: string };
    error.code = errorCode;
    retain.mockRejectedValueOnce(error);

    const response = await app.inject({
      headers,
      method: "POST",
      payload: {
        repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/topic",
        changeIntent: "Review authorization boundaries",
      },
      url: "/api/v1/review-revisions",
    });

    expect(response.statusCode).toBe(statusCode);
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: apiCode });
    expect(response.body).not.toContain("/private/repository");
    expect(response.body).not.toContain("provider stderr");
  });
});

describe("observed Review Revision selection", () => {
  const project = {
    id: projectId,
    providerObservation: {
      authentication: "host_session",
      kind: "host_gh",
      refresh: "manual",
      host: "github.com",
      account: "operator",
    },
    repository: {
      canonicalUrl: "https://github.com/kestrel/review-source",
      name: "review-source",
      owner: "kestrel",
      providerId: "R_123",
    },
    localRepositorySource: {
      id: "018f0f89-a51b-7b6e-94e8-0a4113f61370",
      repositoryId,
      displayName: "review-source",
      state: "attached",
      objectFormat: "sha1",
      createdAt: "2026-08-24T12:00:00.000Z",
      updatedAt: "2026-08-24T12:00:00.000Z",
    },
    sourceAvailability: "not_acquired",
    modelAccess: "not_configured",
    createdAt: "2026-08-24T12:00:00.000Z",
    updatedAt: "2026-08-24T12:00:00.000Z",
    changeProposals: [
      {
        kind: "provider_observed",
        id: proposalId,
        version: 1,
        providerId: "PR_123",
        number: 42,
        title: "Review exact source",
        canonicalUrl: "https://github.com/kestrel/review-source/pull/42",
        proposalState: "open",
        base: { objectId: "a".repeat(40), ref: "main" },
        head: { objectId: "b".repeat(40), ref: "review-source" },
        author: null,
        observedAt: "2026-08-24T12:00:00.000Z",
        changeIntent: null,
        changeIntentCandidates: [],
        reviewRevisions: [],
      },
    ],
  } satisfies Project;

  it("derives every Git pointer and remote coordinate from the expected Project", () => {
    expect(
      resolveObservedReviewRevisionSelection(project, {
        projectId,
        changeProposalId: proposalId,
        changeIntent: "Review exact source",
      }),
    ).toEqual({
      base: { objectId: "a".repeat(40), ref: "main" },
      head: { objectId: "b".repeat(40), ref: "review-source" },
      objectFormat: "sha1",
      projectId,
      pullRequestNumber: 42,
      repository: { name: "review-source", owner: "kestrel" },
      repositoryId,
    });
  });

  it("rejects a proposal whose canonical URL retargets another repository", () => {
    const mismatched = structuredClone(project);
    const proposal = mismatched.changeProposals[0];
    if (proposal?.kind !== "provider_observed") {
      throw new Error("Provider proposal fixture is unavailable");
    }
    proposal.canonicalUrl = "https://github.com/kestrel/other/pull/42";

    expect(() =>
      resolveObservedReviewRevisionSelection(mismatched, {
        projectId,
        changeProposalId: proposalId,
        changeIntent: "Review exact source",
      }),
    ).toThrow(expect.objectContaining({ code: "change_proposal_mismatch" }));
  });
});

describe("Review Revision completion recovery", () => {
  it("resolves a proposal canonicalized after acquisition by its retained revision", () => {
    const revision = {
      id: "018f0f89-9a21-7271-b92d-f1cb0d48bb47",
      state: "available",
      objectFormat: "sha1",
      base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
      head: { objectId: "b".repeat(40), ref: "refs/heads/review-source" },
      objectCount: 7,
      retainedBytes: 4096,
      failureReason: null,
      createdAt: "2026-08-24T12:00:30.000Z",
      availableAt: "2026-08-24T12:01:00.000Z",
    } as const;
    const intent = {
      acceptanceOutcomes: [],
      id: "018f0f89-9a20-79f9-9990-dda80c9b917d",
      objective: "Review the authorization boundary.",
      resolution: {
        state: "unresolved" as const,
        issues: [
          { kind: "missing" as const, field: "scope_boundaries" as const },
          { kind: "missing" as const, field: "acceptance_outcomes" as const },
        ],
      },
      scopeBoundaries: [],
      sourceDigest: "a".repeat(64),
      sources: [
        {
          id: "operator_input",
          kind: "operator_input" as const,
          label: "Operator input",
          provenance: { kind: "operator_input" as const },
          text: "Review the authorization boundary.",
          version: "1",
        },
      ],
      version: 1,
      text: "Review the authorization boundary.",
      createdAt: "2026-08-24T12:00:30.000Z",
    };
    const localRepositorySource = {
      id: "018f0f89-9a1d-7484-b224-866ef9d69990",
      repositoryId,
      displayName: "kestrel",
      state: "attached" as const,
      objectFormat: "sha1" as const,
      createdAt: "2026-08-24T12:00:00.000Z",
      updatedAt: "2026-08-24T12:01:00.000Z",
    };
    const canonicalProposal = {
      kind: "local" as const,
      id: "018f0f89-9192-755f-aa96-f72094c734dd",
      version: 1,
      title: "Review local authorization changes",
      base: revision.base,
      head: revision.head,
      changeIntent: intent,
      changeIntentCandidates: [],
      reviewRevisions: [revision],
      createdAt: "2026-08-24T12:00:30.000Z",
      updatedAt: "2026-08-24T12:01:00.000Z",
    };

    expect(
      buildReviewRevisionResponse(
        {
          id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
          providerObservation: null,
          repository: null,
          localRepositorySource,
          sourceAvailability: "available",
          modelAccess: "not_configured",
          changeProposals: [canonicalProposal],
          createdAt: "2026-08-24T12:00:00.000Z",
          updatedAt: "2026-08-24T12:01:00.000Z",
        },
        "018f0f89-9192-755f-aa96-f72094c734de",
        intent,
        revision,
      ).changeProposal.id,
    ).toBe(canonicalProposal.id);
  });

  it("quarantines while the acquiring row is locked and before recording unavailable", async () => {
    const order: string[] = [];
    const quarantine = vi.fn(() => {
      order.push("quarantine");
      return Promise.resolve();
    });

    await recoverCompletionFailure(async (beforeUnavailable) => {
      await beforeUnavailable();
      order.push("unavailable");
    }, quarantine);
    expect(quarantine).toHaveBeenCalledOnce();
    expect(order).toEqual(["quarantine", "unavailable"]);
  });

  it("preserves the artifact when the availability transition may have committed", async () => {
    const quarantine = vi.fn(() => Promise.resolve());

    await recoverCompletionFailure(
      () => Promise.reject(new Error("state no longer acquiring")),
      quarantine,
    );
    expect(quarantine).not.toHaveBeenCalled();
  });
});

void (null as ReviewRevisionAvailable | null);
