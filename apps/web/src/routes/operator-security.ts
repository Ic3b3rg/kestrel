import { createHash, randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  ApiErrorSchema,
  CredentialChangeCommandSchema,
  credentialChangeCommandJsonSchema,
  jsonSchemaForEmbedding,
  serializeCredentialChangeCommand,
  StepUpCommandSchema,
  stepUpCommandJsonSchema,
  StepUpProofSchema,
  StepUpProofTokenSchema,
  stepUpProofJsonSchema,
  apiErrorJsonSchema,
  type Session,
  type StepUpAction,
  type StepUpCommand,
} from "@kestrel/contracts";
import {
  appendAuditRecord,
  changeOperatorCredentials,
  consumeAuthenticationRateLimit,
  issueOperatorStepUpProof,
  readOperatorCredentials,
  type DatabasePool,
} from "@kestrel/database";

import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import { ARGON2ID_DUMMY_HASH, hashPassword, verifyPassword } from "../password.js";
import { serializeClearedAuthenticationCookies } from "../session.js";

const STEP_UP_RATE_LIMIT = 5;
const STEP_UP_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const CREDENTIAL_CHANGE_RATE_LIMIT = 5;
const CREDENTIAL_CHANGE_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const STEP_UP_HEADER_NAME = "x-kestrel-step-up";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stepUpTargetType(action: StepUpAction): string {
  switch (action) {
    case "operator_credentials_change":
      return "operator";
    case "provider_connect":
    case "provider_disconnect":
    case "provider_replace":
      return "provider";
    case "model_credentials_change":
      return "model";
    case "project_delete":
      return "project";
    case "installation_update":
      return "installation";
  }
}

function requireOperatorSession(request: FastifyRequest): Session {
  if (request.operatorSession === null) {
    throw new Error("Authenticated Operator route has no session");
  }
  return request.operatorSession;
}

function rejectedResponse(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(403).send(
    ApiErrorSchema.parse({
      schemaVersion: 1,
      code: "REQUEST_REJECTED",
      message: "The request was rejected",
      correlationId: request.id,
    }),
  );
}

async function auditStepUpDenial(
  pool: DatabasePool,
  request: FastifyRequest,
  session: Session,
  command: StepUpCommand,
  eventType: "operator.step_up.denied" | "operator.step_up.rate_limited",
  denialReason: "invalid_credentials" | "rate_limit_exceeded" | "stale_session",
): Promise<void> {
  await appendAuditRecord(pool, {
    actorId: session.operator.id,
    actorType: "operator",
    causationId: null,
    correlationId: request.id,
    denialReason,
    eventType,
    facts: { action: command.action },
    outcome: "denied",
    targetId: command.targetId,
    targetType: stepUpTargetType(command.action),
  });
}

async function auditCredentialChangeDenial(
  pool: DatabasePool,
  request: FastifyRequest,
  session: Session,
  denialReason: "invalid_step_up" | "rate_limit_exceeded",
): Promise<void> {
  await appendAuditRecord(pool, {
    actorId: session.operator.id,
    actorType: "operator",
    causationId: null,
    correlationId: request.id,
    denialReason,
    eventType: "operator.credentials_change.denied",
    facts: {},
    outcome: "denied",
    targetId: session.operator.id,
    targetType: "operator",
  });
}

export function registerOperatorSecurityRoutes(app: FastifyInstance, pool: DatabasePool): void {
  app.post(
    "/auth/step-up",
    {
      bodyLimit: 1_024,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        body: jsonSchemaForEmbedding(stepUpCommandJsonSchema),
        response: {
          200: jsonSchemaForEmbedding(stepUpProofJsonSchema),
          400: jsonSchemaForEmbedding(apiErrorJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          403: jsonSchemaForEmbedding(apiErrorJsonSchema),
          413: jsonSchemaForEmbedding(apiErrorJsonSchema),
          415: jsonSchemaForEmbedding(apiErrorJsonSchema),
          429: jsonSchemaForEmbedding(apiErrorJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      const command = StepUpCommandSchema.parse(request.body);
      const session = requireOperatorSession(request);
      try {
        const rateLimit = await consumeAuthenticationRateLimit(
          pool,
          [
            {
              limit: STEP_UP_RATE_LIMIT,
              scope: "operator_step_up_actor",
              subjectDigest: sha256(`operator-step-up-actor\0${session.operator.id}`),
            },
          ],
          STEP_UP_RATE_LIMIT_WINDOW_SECONDS,
        );
        if (!rateLimit.allowed) {
          await auditStepUpDenial(
            pool,
            request,
            session,
            command,
            "operator.step_up.rate_limited",
            "rate_limit_exceeded",
          );
          return await reply
            .header("Retry-After", String(rateLimit.retryAfterSeconds))
            .code(429)
            .send(
              ApiErrorSchema.parse({
                schemaVersion: 1,
                code: "RATE_LIMITED",
                message: "Step-up authentication is temporarily limited",
                correlationId: request.id,
              }),
            );
        }

        const credentials = await readOperatorCredentials(pool, session.operator.username);
        const passwordMatches = await verifyPassword(
          command.password,
          credentials?.passwordHash ?? ARGON2ID_DUMMY_HASH,
        );
        if (
          !credentials ||
          credentials.id !== session.operator.id ||
          credentials.credentialVersion !== session.credentialVersion ||
          !passwordMatches
        ) {
          await auditStepUpDenial(
            pool,
            request,
            session,
            command,
            "operator.step_up.denied",
            "invalid_credentials",
          );
          return await rejectedResponse(request, reply);
        }

        const proof = randomBytes(32).toString("base64url");
        const expiresAt = await issueOperatorStepUpProof(pool, {
          action: command.action,
          correlationId: request.id,
          credentialVersion: session.credentialVersion,
          operatorId: session.operator.id,
          proofDigest: sha256(proof),
          requestDigest: command.requestDigest,
          targetId: command.targetId,
          targetType: stepUpTargetType(command.action),
        });
        if (expiresAt === null) {
          await auditStepUpDenial(
            pool,
            request,
            session,
            command,
            "operator.step_up.denied",
            "stale_session",
          );
          return await rejectedResponse(request, reply);
        }
        return StepUpProofSchema.parse({
          schemaVersion: 1,
          expiresAt: expiresAt.toISOString(),
          proof,
        });
      } catch (error) {
        request.log.error({ err: error, event: "operator.step_up_unavailable" });
        return await reply.code(503).send(
          ApiErrorSchema.parse({
            schemaVersion: 1,
            code: "SERVICE_UNAVAILABLE",
            message: "Step-up authentication is unavailable",
            correlationId: request.id,
          }),
        );
      }
    },
  );

  app.post(
    "/api/v1/operator/credentials",
    {
      bodyLimit: 1_024,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        body: jsonSchemaForEmbedding(credentialChangeCommandJsonSchema),
        response: {
          204: { type: "null" },
          400: jsonSchemaForEmbedding(apiErrorJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          403: jsonSchemaForEmbedding(apiErrorJsonSchema),
          409: jsonSchemaForEmbedding(apiErrorJsonSchema),
          413: jsonSchemaForEmbedding(apiErrorJsonSchema),
          415: jsonSchemaForEmbedding(apiErrorJsonSchema),
          429: jsonSchemaForEmbedding(apiErrorJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      const command = CredentialChangeCommandSchema.parse(request.body);
      const session = requireOperatorSession(request);
      try {
        const rateLimit = await consumeAuthenticationRateLimit(
          pool,
          [
            {
              limit: CREDENTIAL_CHANGE_RATE_LIMIT,
              scope: "operator_credentials_change_actor",
              subjectDigest: sha256(
                `operator-credentials-change-actor\0${session.operator.id}\0${session.credentialVersion}`,
              ),
            },
          ],
          CREDENTIAL_CHANGE_RATE_LIMIT_WINDOW_SECONDS,
        );
        if (!rateLimit.allowed) {
          await auditCredentialChangeDenial(pool, request, session, "rate_limit_exceeded");
          return await reply
            .header("Retry-After", String(rateLimit.retryAfterSeconds))
            .code(429)
            .send(
              ApiErrorSchema.parse({
                schemaVersion: 1,
                code: "RATE_LIMITED",
                message: "Operator credential changes are temporarily limited",
                correlationId: request.id,
              }),
            );
        }

        const parsedProof = StepUpProofTokenSchema.safeParse(request.headers[STEP_UP_HEADER_NAME]);
        if (!parsedProof.success) {
          await auditCredentialChangeDenial(pool, request, session, "invalid_step_up");
          return await rejectedResponse(request, reply);
        }
        const result = await changeOperatorCredentials(pool, {
          correlationId: request.id,
          credentialVersion: session.credentialVersion,
          expectedVersion: command.expectedVersion,
          newPasswordHash: await hashPassword(command.newPassword),
          operatorId: session.operator.id,
          proofDigest: sha256(parsedProof.data),
          requestDigest: sha256(serializeCredentialChangeCommand(command)),
          username: command.username,
        });
        if (result.kind === "proof-rejected") {
          return await rejectedResponse(request, reply);
        }
        if (result.kind === "version-conflict") {
          return await reply.code(409).send(
            ApiErrorSchema.parse({
              schemaVersion: 1,
              code: "OPERATOR_VERSION_CONFLICT",
              message: "The Operator credentials changed before this command",
              correlationId: request.id,
            }),
          );
        }
        for (const cookie of serializeClearedAuthenticationCookies()) {
          reply.header("Set-Cookie", cookie);
        }
        request.log.info({
          event: "operator.credentials_changed",
          operatorId: session.operator.id,
        });
        return await reply.code(204).send();
      } catch (error) {
        request.log.error({ err: error, event: "operator.credentials_change_unavailable" });
        return await reply.code(503).send(
          ApiErrorSchema.parse({
            schemaVersion: 1,
            code: "SERVICE_UNAVAILABLE",
            message: "Operator credential storage is unavailable",
            correlationId: request.id,
          }),
        );
      }
    },
  );
}
