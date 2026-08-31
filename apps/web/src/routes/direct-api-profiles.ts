import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  ApiErrorSchema,
  ConfigureDirectApiProfileCommandSchema,
  DirectApiProfileResponseSchema,
  KestrelIdSchema,
  StepUpProofTokenSchema,
  apiErrorJsonSchema,
  configureDirectApiProfileCommandJsonSchema,
  directApiProfileResponseJsonSchema,
  jsonSchemaForEmbedding,
  serializeConfigureDirectApiProfileCommand,
  type ApiError,
  type ConfigureDirectApiProfileCommand,
  type CredentialVersion,
  type DirectApiProfile,
} from "@kestrel/contracts";
import {
  authorizeDirectApiProfileChange,
  consumeAuthenticationRateLimit,
  persistDirectApiProfile,
  readDirectApiProfile,
  readDirectApiProfileBrokerReference,
  recordDirectApiProfileTest,
  type DatabasePool,
} from "@kestrel/database";
import {
  CredentialStoreError,
  DirectApiBrokerError,
  certifyDirectApiProfile,
  type CredentialStore,
  type OpenAiTransport,
} from "@kestrel/model-provider";

import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import { sha256, stepUpRequestBinding } from "../step-up-binding.js";

const PROFILE_TEST_RATE_LIMIT = 5;
const PROFILE_TEST_RATE_WINDOW_SECONDS = 15 * 60;

export type DirectApiProfileServiceErrorCode =
  | "not_found"
  | "profile_not_configured"
  | "profile_test_failed"
  | "proof_rejected"
  | "rate_limited"
  | "service_unavailable";

export class DirectApiProfileServiceError extends Error {
  public constructor(
    public readonly code: DirectApiProfileServiceErrorCode,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`Direct API profile operation failed: ${code}`);
    this.name = "DirectApiProfileServiceError";
  }
}

export interface DirectApiProfileRequestContext {
  actorId: string;
  correlationId: string;
  credentialVersion: CredentialVersion;
  projectId: string;
}

export interface ConfigureDirectApiProfileContext extends DirectApiProfileRequestContext {
  stepUpProof: string;
}

export interface DirectApiProfileService {
  configure(
    command: ConfigureDirectApiProfileCommand,
    context: ConfigureDirectApiProfileContext,
  ): Promise<{ credentialCleanupFailed: boolean; profile: DirectApiProfile }>;
  read(projectId: string): Promise<{ profile: DirectApiProfile | null; projectFound: boolean }>;
  test(context: DirectApiProfileRequestContext): Promise<DirectApiProfile>;
}

async function enforceSyntheticTestRateLimit(
  pool: DatabasePool,
  actorId: string,
  projectId: string,
): Promise<void> {
  const result = await consumeAuthenticationRateLimit(
    pool,
    [
      {
        limit: PROFILE_TEST_RATE_LIMIT,
        scope: "direct_api_profile_test",
        subjectDigest: sha256(`direct-api-profile-test\0${actorId}\0${projectId}`),
      },
    ],
    PROFILE_TEST_RATE_WINDOW_SECONDS,
  );
  if (!result.allowed) {
    throw new DirectApiProfileServiceError("rate_limited", result.retryAfterSeconds);
  }
}

function classifyBrokerFailure(error: DirectApiBrokerError): {
  availabilityReason:
    "credential_unavailable" | "identity_drift" | "provider_unavailable" | "synthetic_test_failed";
  serviceCode: Extract<
    DirectApiProfileServiceErrorCode,
    "profile_test_failed" | "service_unavailable"
  >;
} {
  switch (error.code) {
    case "credential_unavailable":
      return {
        availabilityReason: "credential_unavailable",
        serviceCode: "profile_test_failed",
      };
    case "identity_drift":
      return { availabilityReason: "identity_drift", serviceCode: "profile_test_failed" };
    case "provider_unavailable":
    case "destination_rejected":
      return { availabilityReason: "provider_unavailable", serviceCode: "service_unavailable" };
    case "request_invalid":
    case "response_invalid":
    case "synthetic_test_failed":
      return {
        availabilityReason: "synthetic_test_failed",
        serviceCode: "profile_test_failed",
      };
  }
}

function serviceErrorForBroker(error: DirectApiBrokerError): DirectApiProfileServiceError {
  return new DirectApiProfileServiceError(classifyBrokerFailure(error).serviceCode);
}

export function createDirectApiProfileService(
  pool: DatabasePool,
  credentialStore: CredentialStore,
  transport: OpenAiTransport,
  signingKey: Buffer,
): DirectApiProfileService {
  return {
    read: (projectId) => readDirectApiProfile(pool, projectId),

    async configure(command, context) {
      await enforceSyntheticTestRateLimit(pool, context.actorId, context.projectId);
      const authorization = await authorizeDirectApiProfileChange(pool, {
        correlationId: context.correlationId,
        credentialVersion: context.credentialVersion,
        operatorId: context.actorId,
        profileRequestBindingHmac: stepUpRequestBinding(
          sha256(serializeConfigureDirectApiProfileCommand(command)),
          signingKey,
        ),
        projectId: context.projectId,
        proofDigest: sha256(context.stepUpProof),
      });
      if (authorization.kind === "not_found") {
        throw new DirectApiProfileServiceError("not_found");
      }
      if (authorization.kind === "proof_rejected") {
        throw new DirectApiProfileServiceError("proof_rejected");
      }

      let certification;
      try {
        certification = await certifyDirectApiProfile(
          {
            apiKey: command.apiKey,
            limits: command.limits,
            model: command.model,
            openAiProjectId: command.openAiProjectId,
            organizationId: command.organizationId,
          },
          transport,
        );
      } catch (error) {
        if (error instanceof DirectApiBrokerError) throw serviceErrorForBroker(error);
        throw new DirectApiProfileServiceError("service_unavailable");
      }

      let credentialHandle: string;
      try {
        credentialHandle = await credentialStore.put(
          authorization.canonicalProjectId,
          command.apiKey,
        );
      } catch {
        throw new DirectApiProfileServiceError("service_unavailable");
      }
      const configuration = {
        dataPolicy: command.dataPolicy,
        displayName: command.displayName,
        limits: command.limits,
        model: command.model,
        openAiProjectId: command.openAiProjectId,
        organizationId: command.organizationId,
        priceSnapshot: command.priceSnapshot,
      };
      let persisted;
      try {
        persisted = await persistDirectApiProfile(pool, {
          actorId: context.actorId,
          certification,
          configuration,
          correlationId: context.correlationId,
          credentialHandle,
          projectId: authorization.canonicalProjectId,
        });
      } catch {
        await credentialStore
          .delete(authorization.canonicalProjectId, credentialHandle)
          .catch(() => undefined);
        throw new DirectApiProfileServiceError("service_unavailable");
      }

      let credentialCleanupFailed = false;
      if (
        persisted.replacedCredentialHandle !== null &&
        persisted.replacedCredentialHandle !== credentialHandle
      ) {
        try {
          await credentialStore.delete(
            authorization.canonicalProjectId,
            persisted.replacedCredentialHandle,
          );
        } catch {
          credentialCleanupFailed = true;
        }
      }
      return { credentialCleanupFailed, profile: persisted.profile };
    },

    async test(context) {
      await enforceSyntheticTestRateLimit(pool, context.actorId, context.projectId);
      const stored = await readDirectApiProfileBrokerReference(pool, context.projectId);
      if (!stored.projectFound) throw new DirectApiProfileServiceError("not_found");
      if (stored.reference === null) {
        throw new DirectApiProfileServiceError("profile_not_configured");
      }
      const { credentialHandle, profile } = stored.reference;
      let apiKey: string;
      try {
        apiKey = await credentialStore.read(profile.projectId, credentialHandle);
      } catch (error) {
        if (error instanceof CredentialStoreError) {
          await recordDirectApiProfileTest(pool, {
            projectId: profile.projectId,
            reason: "credential_unavailable",
          });
          throw new DirectApiProfileServiceError("profile_test_failed");
        }
        throw new DirectApiProfileServiceError("service_unavailable");
      }

      try {
        const certification = await certifyDirectApiProfile(
          {
            apiKey,
            limits: profile.limits,
            model: profile.effectiveIdentity.model,
            openAiProjectId: profile.effectiveIdentity.openAiProjectId,
            organizationId: profile.effectiveIdentity.organizationId,
          },
          transport,
        );
        const updated = await recordDirectApiProfileTest(pool, {
          certification,
          projectId: profile.projectId,
        });
        if (updated === null) throw new DirectApiProfileServiceError("not_found");
        return updated;
      } catch (error) {
        if (error instanceof DirectApiProfileServiceError) throw error;
        if (error instanceof DirectApiBrokerError) {
          const failure = classifyBrokerFailure(error);
          await recordDirectApiProfileTest(pool, {
            projectId: profile.projectId,
            reason: failure.availabilityReason,
          });
          throw new DirectApiProfileServiceError(failure.serviceCode);
        }
        throw new DirectApiProfileServiceError("service_unavailable");
      }
    },
  };
}

export function createUnavailableDirectApiProfileService(
  pool: DatabasePool,
): DirectApiProfileService {
  const unavailable = () => Promise.reject(new DirectApiProfileServiceError("service_unavailable"));
  return {
    configure: unavailable,
    read: (projectId) => readDirectApiProfile(pool, projectId),
    test: unavailable,
  };
}

function apiError(request: FastifyRequest, code: ApiError["code"], message: string): ApiError {
  return ApiErrorSchema.parse({ schemaVersion: 1, code, message, correlationId: request.id });
}

function serviceErrorResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  error: DirectApiProfileServiceError,
) {
  switch (error.code) {
    case "not_found":
      return reply.code(404).send(apiError(request, "NOT_FOUND", "The Project is unavailable"));
    case "profile_not_configured":
      return reply
        .code(404)
        .send(apiError(request, "NOT_FOUND", "A Direct API profile is not configured"));
    case "proof_rejected":
      return reply
        .code(403)
        .send(apiError(request, "REQUEST_REJECTED", "The request was rejected"));
    case "profile_test_failed":
      return reply
        .code(422)
        .send(apiError(request, "REQUEST_REJECTED", "The exact Direct API profile test failed"));
    case "rate_limited":
      return reply
        .header("Retry-After", String(error.retryAfterSeconds ?? 1))
        .code(429)
        .send(
          apiError(request, "RATE_LIMITED", "Direct API profile tests are temporarily limited"),
        );
    case "service_unavailable":
      return reply
        .code(503)
        .send(apiError(request, "SERVICE_UNAVAILABLE", "The Direct API profile is unavailable"));
  }
}

export function registerDirectApiProfileRoutes(
  app: FastifyInstance,
  service: DirectApiProfileService,
): void {
  const profilePath = "/api/v1/projects/:projectId/model-profiles/direct-api";
  app.get(
    profilePath,
    {
      schema: {
        response: {
          200: jsonSchemaForEmbedding(directApiProfileResponseJsonSchema),
          400: jsonSchemaForEmbedding(apiErrorJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          404: jsonSchemaForEmbedding(apiErrorJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      const parsedProjectId = KestrelIdSchema.safeParse(
        (request.params as { projectId: string }).projectId,
      );
      if (!parsedProjectId.success) {
        return reply
          .code(400)
          .send(apiError(request, "INVALID_REQUEST", "The Project identity is invalid"));
      }
      try {
        const result = await service.read(parsedProjectId.data);
        if (!result.projectFound) {
          return await reply
            .code(404)
            .send(apiError(request, "NOT_FOUND", "The Project is unavailable"));
        }
        return DirectApiProfileResponseSchema.parse({ schemaVersion: 1, profile: result.profile });
      } catch (error) {
        request.log.error({ err: error, event: "model_profile.direct_api_read_failed" });
        return reply
          .code(503)
          .send(apiError(request, "SERVICE_UNAVAILABLE", "The Direct API profile is unavailable"));
      }
    },
  );

  app.post(
    profilePath,
    {
      bodyLimit: 16 * 1024,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        body: jsonSchemaForEmbedding(configureDirectApiProfileCommandJsonSchema),
        response: {
          201: jsonSchemaForEmbedding(directApiProfileResponseJsonSchema),
          400: jsonSchemaForEmbedding(apiErrorJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          403: jsonSchemaForEmbedding(apiErrorJsonSchema),
          404: jsonSchemaForEmbedding(apiErrorJsonSchema),
          409: jsonSchemaForEmbedding(apiErrorJsonSchema),
          413: jsonSchemaForEmbedding(apiErrorJsonSchema),
          415: jsonSchemaForEmbedding(apiErrorJsonSchema),
          422: jsonSchemaForEmbedding(apiErrorJsonSchema),
          429: jsonSchemaForEmbedding(apiErrorJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      const parsedProjectId = KestrelIdSchema.safeParse(
        (request.params as { projectId: string }).projectId,
      );
      const parsedCommand = ConfigureDirectApiProfileCommandSchema.safeParse(request.body);
      if (!parsedProjectId.success || !parsedCommand.success) {
        return reply
          .code(400)
          .send(apiError(request, "INVALID_REQUEST", "The Direct API profile request is invalid"));
      }
      const parsedProof = StepUpProofTokenSchema.safeParse(request.headers["x-kestrel-step-up"]);
      if (!parsedProof.success) {
        return reply
          .code(403)
          .send(apiError(request, "REQUEST_REJECTED", "The request was rejected"));
      }
      const session = request.operatorSession;
      if (session === null) throw new Error("Authenticated model profile route has no session");
      try {
        const result = await service.configure(parsedCommand.data, {
          actorId: session.operator.id,
          correlationId: request.id,
          credentialVersion: session.credentialVersion,
          projectId: parsedProjectId.data,
          stepUpProof: parsedProof.data,
        });
        if (result.credentialCleanupFailed) {
          request.log.warn({ event: "model_profile.replaced_credential_cleanup_failed" });
        }
        return await reply.code(201).send(
          DirectApiProfileResponseSchema.parse({
            schemaVersion: 1,
            profile: result.profile,
          }),
        );
      } catch (error) {
        if (error instanceof DirectApiProfileServiceError) {
          return serviceErrorResponse(request, reply, error);
        }
        request.log.error({ err: error, event: "model_profile.direct_api_configure_failed" });
        return reply
          .code(503)
          .send(apiError(request, "SERVICE_UNAVAILABLE", "The Direct API profile is unavailable"));
      }
    },
  );

  app.post(
    `${profilePath}/test`,
    {
      bodyLimit: 1_024,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        body: { additionalProperties: false, type: "object" },
        response: {
          200: jsonSchemaForEmbedding(directApiProfileResponseJsonSchema),
          400: jsonSchemaForEmbedding(apiErrorJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          403: jsonSchemaForEmbedding(apiErrorJsonSchema),
          404: jsonSchemaForEmbedding(apiErrorJsonSchema),
          409: jsonSchemaForEmbedding(apiErrorJsonSchema),
          422: jsonSchemaForEmbedding(apiErrorJsonSchema),
          429: jsonSchemaForEmbedding(apiErrorJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      const parsedProjectId = KestrelIdSchema.safeParse(
        (request.params as { projectId: string }).projectId,
      );
      if (!parsedProjectId.success) {
        return reply
          .code(400)
          .send(apiError(request, "INVALID_REQUEST", "The Project identity is invalid"));
      }
      const session = request.operatorSession;
      if (session === null) throw new Error("Authenticated model profile route has no session");
      try {
        const profile = await service.test({
          actorId: session.operator.id,
          correlationId: request.id,
          credentialVersion: session.credentialVersion,
          projectId: parsedProjectId.data,
        });
        return DirectApiProfileResponseSchema.parse({ schemaVersion: 1, profile });
      } catch (error) {
        if (error instanceof DirectApiProfileServiceError) {
          return serviceErrorResponse(request, reply, error);
        }
        request.log.error({ err: error, event: "model_profile.direct_api_test_failed" });
        return reply
          .code(503)
          .send(apiError(request, "SERVICE_UNAVAILABLE", "The Direct API profile is unavailable"));
      }
    },
  );
}
