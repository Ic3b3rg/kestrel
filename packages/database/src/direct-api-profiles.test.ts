import { describe, expect, it, vi } from "vitest";

import {
  authorizeDirectApiProfileChange,
  mapDirectApiProfileRow,
  persistDirectApiProfile,
  type DirectApiProfileDatabaseRow,
} from "./direct-api-profiles.js";

const projectId = "018f0f89-8f75-7cc4-9860-3fda5f75d697";
const operatorId = "018f0f89-a21d-7e31-8d27-aa4383f22991";

function profileRow(
  overrides: Partial<DirectApiProfileDatabaseRow> = {},
): DirectApiProfileDatabaseRow {
  return {
    availability: "available",
    availability_reasons: [],
    created_at: new Date("2026-08-31T12:01:00.000Z"),
    credential_handle: "cred_abcdefghijklmnopqrstuvwxyzABCDEFGH123456789",
    data_policy: {
      abuseMonitoring: "modified",
      attestedAt: "2026-08-31T12:00:00.000Z",
      evidenceUrl: "https://developers.openai.com/api/docs/guides/your-data",
      expiresAt: "2026-09-30T12:00:00.000Z",
      humanReview: "restricted",
      processingRegions: ["US"],
      storageRegions: ["US"],
      trainingUse: "not_used_without_opt_in",
    },
    display_name: "OpenAI direct review",
    expected_resolved_model_id: "gpt-test-2026-08-01",
    id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
    last_test_passed_at: new Date("2026-08-31T12:01:00.000Z"),
    limits: {
      maximumAttempts: 1,
      maximumConcurrentRequests: 1,
      maximumCostUsd: "2.500000",
      maximumInputTokens: 100_000,
      maximumOutputTokens: 8_192,
      maximumRequestBytes: 1_048_576,
      requestTimeoutMilliseconds: 60_000,
    },
    observed_api_version: "2020-10-01",
    observed_model: "gpt-test-2026-08-01",
    observed_organization_id: "org_example",
    openai_project_id: "proj_example",
    organization_id: "org_example",
    price_snapshot: {
      cachedInputPerMillionTokensUsd: "0.125000",
      capturedAt: "2026-08-31T12:00:00.000Z",
      currency: "USD",
      effectiveAt: "2026-08-01T00:00:00.000Z",
      inputPerMillionTokensUsd: "1.250000",
      outputPerMillionTokensUsd: "10.000000",
      sourceUrl: "https://developers.openai.com/api/docs/pricing",
    },
    profile_digest: "6".repeat(64),
    project_id: projectId,
    requested_model_id: "gpt-test-2026-08-01",
    synthetic_request_id: "req_synthetic_example",
    updated_at: new Date("2026-08-31T12:01:00.000Z"),
    ...overrides,
  };
}

describe("Direct API profile persistence", () => {
  it("maps a safe effective profile and marks an expired attestation stale", () => {
    const available = mapDirectApiProfileRow(profileRow(), new Date("2026-09-01T12:00:00.000Z"));
    expect(available).toMatchObject({
      availability: "available",
      effectiveIdentity: {
        apiSurface: "responses",
        endpointOrigin: "https://api.openai.com",
        model: { versionPolicy: "pinned" },
        provider: "openai",
      },
      executionPolicy: { statefulness: "stateless", tools: "disabled" },
    });
    expect(available).not.toHaveProperty("credentialHandle");

    expect(
      mapDirectApiProfileRow(profileRow(), new Date("2026-10-01T00:00:00.000Z")),
    ).toMatchObject({
      availability: "stale",
      availabilityReasons: ["attestation_expired"],
    });
  });

  it("consumes the exact model-credential step-up proof before certification", async () => {
    const query = vi.fn((statement: string, _parameters?: readonly unknown[]) => {
      if (statement === "BEGIN" || statement === "COMMIT") return { rowCount: null, rows: [] };
      if (statement.includes("COALESCE(canonical_project_id")) {
        return { rowCount: 1, rows: [{ id: projectId }] };
      }
      if (statement.includes("WITH consumed AS")) {
        return {
          rowCount: 1,
          rows: [
            {
              action: "model_credentials_change",
              credential_version: "3",
              is_unexpired: true,
              jwt_signing_generation: "2",
              operator_id: operatorId,
              request_binding_hmac: "2".repeat(64),
              target_id: projectId,
            },
          ],
        };
      }
      if (statement.includes("FROM operators") && statement.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [{ id: operatorId }] };
      }
      if (statement.includes("pg_advisory_xact_lock")) return { rowCount: 1, rows: [{}] };
      if (statement.includes("FROM installation_audit_records")) return { rowCount: 0, rows: [] };
      if (statement.includes("nextval")) {
        return {
          rowCount: 1,
          rows: [{ id: "1", occurred_at: new Date("2026-08-31T12:00:00.000Z") }],
        };
      }
      if (statement.includes("INSERT INTO installation_audit_records")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
    const release = vi.fn();

    await expect(
      authorizeDirectApiProfileChange({ connect: vi.fn(() => ({ query, release })) } as never, {
        correlationId: "018f0f89-a3fb-75ee-bccc-08c031ce5f10",
        credentialVersion: "3",
        operatorId,
        profileRequestBindingHmac: "2".repeat(64),
        projectId,
        proofDigest: "1".repeat(64),
      }),
    ).resolves.toEqual({ kind: "authorized", canonicalProjectId: projectId });
    expect(
      query.mock.calls.find(([statement]) => statement.includes("WITH consumed AS"))?.[1],
    ).toEqual(["1".repeat(64)]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("persists no credential bytes and returns the replaced opaque handle", async () => {
    const insertedRow = profileRow();
    const query = vi.fn((statement: string, parameters?: readonly unknown[]) => {
      if (statement === "BEGIN" || statement === "COMMIT") return { rowCount: null, rows: [] };
      if (statement.includes("FROM direct_api_profiles") && statement.includes("FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [{ credential_handle: "cred_oldoldoldoldoldoldoldoldoldoldoldoldoldold1" }],
        };
      }
      if (statement.includes("INSERT INTO direct_api_profiles")) {
        expect(JSON.stringify(parameters)).not.toContain("sk-project-exclusive");
        return { rowCount: 1, rows: [insertedRow] };
      }
      if (statement.includes("pg_advisory_xact_lock")) return { rowCount: 1, rows: [{}] };
      if (statement.includes("FROM installation_audit_records")) return { rowCount: 0, rows: [] };
      if (statement.includes("nextval")) {
        return {
          rowCount: 1,
          rows: [{ id: "2", occurred_at: new Date("2026-08-31T12:01:00.000Z") }],
        };
      }
      if (statement.includes("INSERT INTO installation_audit_records")) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    });

    const result = await persistDirectApiProfile(
      { connect: vi.fn(() => ({ query, release: vi.fn() })) } as never,
      {
        actorId: operatorId,
        certification: {
          observedApiVersion: "2020-10-01",
          observedModel: "gpt-test-2026-08-01",
          observedOrganizationId: "org_example",
          passedAt: "2026-08-31T12:01:00.000Z",
          requestId: "req_synthetic_example",
        },
        configuration: {
          dataPolicy: profileRow().data_policy as never,
          displayName: "OpenAI direct review",
          limits: profileRow().limits as never,
          model: {
            expectedResolvedId: "gpt-test-2026-08-01",
            requestedId: "gpt-test-2026-08-01",
            versionPolicy: "pinned",
          },
          openAiProjectId: "proj_example",
          organizationId: "org_example",
          priceSnapshot: profileRow().price_snapshot as never,
        },
        correlationId: "018f0f89-a3fb-75ee-bccc-08c031ce5f10",
        credentialHandle: "cred_abcdefghijklmnopqrstuvwxyzABCDEFGH123456789",
        projectId,
      },
    );

    expect(result.replacedCredentialHandle).toContain("cred_old");
    expect(result.profile).not.toHaveProperty("credentialHandle");
  });
});
