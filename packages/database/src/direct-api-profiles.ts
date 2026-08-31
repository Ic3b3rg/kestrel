import { createHash } from "node:crypto";

import {
  CorrelationIdSchema,
  DirectApiDataPolicySchema,
  DirectApiLimitsSchema,
  DirectApiPriceSnapshotSchema,
  DirectApiProfileAvailabilityReasonSchema,
  DirectApiProfileSchema,
  KestrelIdSchema,
  type ConfigureDirectApiProfileCommand,
  type CredentialVersion,
  type DirectApiProfile,
  type DirectApiProfileAvailabilityReason,
  type DirectApiSyntheticTest,
} from "@kestrel/contracts";

import { appendAuditRecordInTransaction } from "./audit.js";
import { consumeOperatorStepUpProofInTransaction } from "./operator-security.js";
import type { DatabasePool } from "./pool.js";

const credentialHandlePattern = /^cred_[A-Za-z0-9_-]{43}$/u;

export type DirectApiProfileConfiguration = Omit<ConfigureDirectApiProfileCommand, "apiKey">;

export interface DirectApiProfileDatabaseRow {
  availability: "available" | "stale" | "unavailable";
  availability_reasons: unknown;
  attestation_expires_at?: Date;
  created_at: Date;
  credential_handle: string;
  data_policy: unknown;
  display_name: string;
  expected_resolved_model_id: string;
  id: string;
  last_test_passed_at: Date;
  limits: unknown;
  observed_api_version: string;
  observed_model: string;
  observed_organization_id: string;
  openai_project_id: string;
  organization_id: string;
  price_snapshot: unknown;
  profile_digest: string;
  project_id: string;
  requested_model_id: string;
  synthetic_request_id: string;
  updated_at: Date;
}

const executionPolicy = {
  arbitraryOptions: "disabled",
  callbacks: "disabled",
  files: "disabled",
  inputModality: "text",
  privilegedInstructions: "developer",
  retrieval: "disabled",
  statefulness: "stateless",
  structuredOutput: "json_schema_strict",
  tools: "disabled",
  urls: "disabled",
} as const;

function safeConfiguration(
  configuration: DirectApiProfileConfiguration,
): DirectApiProfileConfiguration {
  return {
    dataPolicy: DirectApiDataPolicySchema.parse(configuration.dataPolicy),
    displayName: configuration.displayName.trim(),
    limits: DirectApiLimitsSchema.parse(configuration.limits),
    model: {
      expectedResolvedId: configuration.model.expectedResolvedId,
      requestedId: configuration.model.requestedId,
      versionPolicy: "pinned",
    },
    openAiProjectId: configuration.openAiProjectId,
    organizationId: configuration.organizationId,
    priceSnapshot: DirectApiPriceSnapshotSchema.parse(configuration.priceSnapshot),
  };
}

function digestProfile(configuration: DirectApiProfileConfiguration): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        effectiveIdentity: {
          apiSurface: "responses",
          apiVersion: "2020-10-01",
          endpointOrigin: "https://api.openai.com",
          endpointPath: "/v1/responses",
          model: configuration.model,
          openAiProjectId: configuration.openAiProjectId,
          organizationId: configuration.organizationId,
          provider: "openai",
        },
        executionPolicy,
        dataPolicy: configuration.dataPolicy,
        limits: configuration.limits,
        priceSnapshot: configuration.priceSnapshot,
      }),
      "utf8",
    )
    .digest("hex");
}

function availabilityForRow(
  row: DirectApiProfileDatabaseRow,
  expiresAt: string,
  now: Date,
): Pick<DirectApiProfile, "availability" | "availabilityReasons"> {
  const reasons = new Set(
    DirectApiProfileAvailabilityReasonSchema.array().max(6).parse(row.availability_reasons),
  );
  let availability = row.availability;

  if (
    row.observed_api_version !== "2020-10-01" ||
    row.observed_model !== row.expected_resolved_model_id ||
    row.observed_organization_id !== row.organization_id
  ) {
    availability = "unavailable";
    reasons.add("identity_drift");
  }
  if (expiresAt <= now.toISOString()) {
    if (availability === "available") availability = "stale";
    reasons.add("attestation_expired");
  }
  if (availability === "available") reasons.clear();

  return {
    availability,
    availabilityReasons: [...reasons].sort() as DirectApiProfileAvailabilityReason[],
  };
}

export function mapDirectApiProfileRow(
  row: DirectApiProfileDatabaseRow,
  now: Date = new Date(),
): DirectApiProfile {
  const dataPolicy = DirectApiDataPolicySchema.parse(row.data_policy);
  const availability = availabilityForRow(row, dataPolicy.expiresAt, now);
  return DirectApiProfileSchema.parse({
    id: row.id,
    projectId: row.project_id,
    ...availability,
    displayName: row.display_name,
    effectiveIdentity: {
      apiSurface: "responses",
      apiVersion: "2020-10-01",
      endpointOrigin: "https://api.openai.com",
      endpointPath: "/v1/responses",
      model: {
        expectedResolvedId: row.expected_resolved_model_id,
        requestedId: row.requested_model_id,
        versionPolicy: "pinned",
      },
      openAiProjectId: row.openai_project_id,
      organizationId: row.organization_id,
      provider: "openai",
    },
    executionPolicy,
    dataPolicy,
    limits: DirectApiLimitsSchema.parse(row.limits),
    priceSnapshot: DirectApiPriceSnapshotSchema.parse(row.price_snapshot),
    profileDigest: row.profile_digest,
    lastTest: {
      observedApiVersion: row.observed_api_version,
      observedModel: row.observed_model,
      observedOrganizationId: row.observed_organization_id,
      passedAt: row.last_test_passed_at.toISOString(),
      requestId: row.synthetic_request_id,
    },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

export interface AuthorizeDirectApiProfileChangeInput {
  correlationId: string;
  credentialVersion: CredentialVersion;
  operatorId: string;
  profileRequestBindingHmac: string;
  projectId: string;
  proofDigest: string;
}

export type AuthorizeDirectApiProfileChangeResult =
  | { kind: "authorized"; canonicalProjectId: string }
  | { kind: "not_found" }
  | { kind: "proof_rejected" };

export async function authorizeDirectApiProfileChange(
  pool: DatabasePool,
  input: AuthorizeDirectApiProfileChangeInput,
): Promise<AuthorizeDirectApiProfileChangeResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const project = await client.query<{ id: string }>(
      `
        SELECT COALESCE(canonical_project_id, id) AS id
        FROM projects
        WHERE id = $1
        FOR UPDATE
      `,
      [KestrelIdSchema.parse(input.projectId)],
    );
    const canonicalProjectId = project.rows[0]?.id;
    if (project.rowCount !== 1 || canonicalProjectId === undefined) {
      await client.query("ROLLBACK");
      return { kind: "not_found" };
    }

    const accepted = await consumeOperatorStepUpProofInTransaction(client, {
      action: "model_credentials_change",
      credentialVersion: input.credentialVersion,
      operatorId: input.operatorId,
      proofDigest: input.proofDigest,
      requestBindingHmac: input.profileRequestBindingHmac,
      targetId: input.projectId,
    });
    await appendAuditRecordInTransaction(client, {
      actorId: KestrelIdSchema.parse(input.operatorId),
      actorType: "operator",
      causationId: null,
      correlationId: CorrelationIdSchema.parse(input.correlationId),
      denialReason: accepted ? null : "invalid_step_up",
      eventType: "model_profile.change.authorized",
      facts: {},
      outcome: accepted ? "succeeded" : "denied",
      targetId: canonicalProjectId,
      targetType: "project",
    });
    await client.query("COMMIT");
    return accepted ? { kind: "authorized", canonicalProjectId } : { kind: "proof_rejected" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface PersistDirectApiProfileInput {
  actorId: string;
  certification: DirectApiSyntheticTest;
  configuration: DirectApiProfileConfiguration;
  correlationId: string;
  credentialHandle: string;
  projectId: string;
}

export interface PersistDirectApiProfileResult {
  profile: DirectApiProfile;
  replacedCredentialHandle: string | null;
}

export async function persistDirectApiProfile(
  pool: DatabasePool,
  input: PersistDirectApiProfileInput,
): Promise<PersistDirectApiProfileResult> {
  if (!credentialHandlePattern.test(input.credentialHandle)) {
    throw new Error("Direct API credential handle is invalid");
  }
  const projectId = KestrelIdSchema.parse(input.projectId);
  const configuration = safeConfiguration(input.configuration);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const previous = await client.query<{ credential_handle: string }>(
      `
        SELECT credential_handle
        FROM direct_api_profiles
        WHERE project_id = $1
        FOR UPDATE
      `,
      [projectId],
    );
    const inserted = await client.query<DirectApiProfileDatabaseRow>(
      `
        INSERT INTO direct_api_profiles (
          project_id,
          credential_handle,
          display_name,
          organization_id,
          openai_project_id,
          requested_model_id,
          expected_resolved_model_id,
          data_policy,
          attestation_expires_at,
          limits,
          price_snapshot,
          profile_digest,
          availability,
          availability_reasons,
          observed_api_version,
          observed_model,
          observed_organization_id,
          synthetic_request_id,
          last_test_passed_at,
          created_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $10::jsonb, $11::jsonb, $12,
          'available', '[]'::jsonb, $13, $14, $15, $16, $17::timestamptz,
          GREATEST(statement_timestamp(), $17::timestamptz),
          GREATEST(statement_timestamp(), $17::timestamptz)
        )
        ON CONFLICT (project_id) DO UPDATE
        SET credential_handle = EXCLUDED.credential_handle,
            display_name = EXCLUDED.display_name,
            organization_id = EXCLUDED.organization_id,
            openai_project_id = EXCLUDED.openai_project_id,
            requested_model_id = EXCLUDED.requested_model_id,
            expected_resolved_model_id = EXCLUDED.expected_resolved_model_id,
            data_policy = EXCLUDED.data_policy,
            attestation_expires_at = EXCLUDED.attestation_expires_at,
            limits = EXCLUDED.limits,
            price_snapshot = EXCLUDED.price_snapshot,
            profile_digest = EXCLUDED.profile_digest,
            availability = 'available',
            availability_reasons = '[]'::jsonb,
            observed_api_version = EXCLUDED.observed_api_version,
            observed_model = EXCLUDED.observed_model,
            observed_organization_id = EXCLUDED.observed_organization_id,
            synthetic_request_id = EXCLUDED.synthetic_request_id,
            last_test_passed_at = EXCLUDED.last_test_passed_at,
            updated_at = GREATEST(statement_timestamp(), EXCLUDED.last_test_passed_at)
        RETURNING *
      `,
      [
        projectId,
        input.credentialHandle,
        configuration.displayName,
        configuration.organizationId,
        configuration.openAiProjectId,
        configuration.model.requestedId,
        configuration.model.expectedResolvedId,
        JSON.stringify(configuration.dataPolicy),
        configuration.dataPolicy.expiresAt,
        JSON.stringify(configuration.limits),
        JSON.stringify(configuration.priceSnapshot),
        digestProfile(configuration),
        input.certification.observedApiVersion,
        input.certification.observedModel,
        input.certification.observedOrganizationId,
        input.certification.requestId,
        input.certification.passedAt,
      ],
    );
    const row = inserted.rows[0];
    if (inserted.rowCount !== 1 || row === undefined) {
      throw new Error("Direct API profile was not persisted");
    }
    await appendAuditRecordInTransaction(client, {
      actorId: KestrelIdSchema.parse(input.actorId),
      actorType: "operator",
      causationId: null,
      correlationId: CorrelationIdSchema.parse(input.correlationId),
      denialReason: null,
      eventType: "model_profile.direct_api.configured",
      facts: { profileDigest: row.profile_digest },
      outcome: "succeeded",
      targetId: projectId,
      targetType: "project",
    });
    await client.query("COMMIT");
    return {
      profile: mapDirectApiProfileRow(row),
      replacedCredentialHandle: previous.rows[0]?.credential_handle ?? null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function resolveCanonicalProjectId(
  pool: DatabasePool,
  projectId: string,
): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    `
      SELECT COALESCE(canonical_project_id, id) AS id
      FROM projects
      WHERE id = $1
    `,
    [KestrelIdSchema.parse(projectId)],
  );
  return result.rows[0]?.id ?? null;
}

export async function readDirectApiProfile(
  pool: DatabasePool,
  projectId: string,
  now: Date = new Date(),
): Promise<{ projectFound: boolean; profile: DirectApiProfile | null }> {
  const canonicalProjectId = await resolveCanonicalProjectId(pool, projectId);
  if (canonicalProjectId === null) return { projectFound: false, profile: null };
  const result = await pool.query<DirectApiProfileDatabaseRow>(
    "SELECT * FROM direct_api_profiles WHERE project_id = $1",
    [canonicalProjectId],
  );
  const row = result.rows[0];
  return {
    projectFound: true,
    profile: row === undefined ? null : mapDirectApiProfileRow(row, now),
  };
}

export interface DirectApiProfileBrokerReference {
  credentialHandle: string;
  profile: DirectApiProfile;
}

export async function readDirectApiProfileBrokerReference(
  pool: DatabasePool,
  projectId: string,
  now: Date = new Date(),
): Promise<{ projectFound: boolean; reference: DirectApiProfileBrokerReference | null }> {
  const canonicalProjectId = await resolveCanonicalProjectId(pool, projectId);
  if (canonicalProjectId === null) return { projectFound: false, reference: null };
  const result = await pool.query<DirectApiProfileDatabaseRow>(
    "SELECT * FROM direct_api_profiles WHERE project_id = $1",
    [canonicalProjectId],
  );
  const row = result.rows[0];
  if (row === undefined) return { projectFound: true, reference: null };
  if (!credentialHandlePattern.test(row.credential_handle)) {
    throw new Error("Direct API credential handle is invalid");
  }
  return {
    projectFound: true,
    reference: {
      credentialHandle: row.credential_handle,
      profile: mapDirectApiProfileRow(row, now),
    },
  };
}

export async function recordDirectApiProfileTest(
  pool: DatabasePool,
  input: {
    certification?: DirectApiSyntheticTest;
    projectId: string;
    reason?: Extract<
      DirectApiProfileAvailabilityReason,
      "credential_unavailable" | "identity_drift" | "provider_unavailable" | "synthetic_test_failed"
    >;
  },
): Promise<DirectApiProfile | null> {
  const projectId = KestrelIdSchema.parse(input.projectId);
  const result =
    input.certification === undefined
      ? await pool.query<DirectApiProfileDatabaseRow>(
          `
            UPDATE direct_api_profiles
            SET availability = 'unavailable',
                availability_reasons = jsonb_build_array($2::text),
                updated_at = statement_timestamp()
            WHERE project_id = $1
            RETURNING *
          `,
          [projectId, input.reason ?? "synthetic_test_failed"],
        )
      : await pool.query<DirectApiProfileDatabaseRow>(
          `
            UPDATE direct_api_profiles
            SET availability = 'available',
                availability_reasons = '[]'::jsonb,
                observed_api_version = $2,
                observed_model = $3,
                observed_organization_id = $4,
                synthetic_request_id = $5,
                last_test_passed_at = $6::timestamptz,
                updated_at = GREATEST(statement_timestamp(), $6::timestamptz)
            WHERE project_id = $1
            RETURNING *
          `,
          [
            projectId,
            input.certification.observedApiVersion,
            input.certification.observedModel,
            input.certification.observedOrganizationId,
            input.certification.requestId,
            input.certification.passedAt,
          ],
        );
  return result.rows[0] === undefined ? null : mapDirectApiProfileRow(result.rows[0]);
}
