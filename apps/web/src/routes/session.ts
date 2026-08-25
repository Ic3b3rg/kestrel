import { createHash } from "node:crypto";

import type { FastifyInstance } from "fastify";

import {
  ApiErrorSchema,
  apiErrorJsonSchema,
  jsonSchemaForEmbedding,
  LoginCommandSchema,
  loginCommandJsonSchema,
  LogoutCommandSchema,
  logoutCommandJsonSchema,
  sessionJsonSchema,
} from "@kestrel/contracts";
import {
  appendAuditRecord,
  consumeAuthenticationRateLimit,
  readOperatorCredentials,
  type DatabasePool,
} from "@kestrel/database";

import { ARGON2ID_DUMMY_HASH, verifyPassword } from "../password.js";
import {
  createCsrfToken,
  createSessionToken,
  serializeClearedAuthenticationCookies,
  serializeCsrfCookie,
  serializeSessionCookie,
} from "../session.js";
import {
  AUTHENTICATED_MUTATION_ROUTE_CONFIG,
  PUBLIC_MUTATION_ROUTE_CONFIG,
} from "../authentication.js";

const LOGIN_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const LOGIN_PRINCIPAL_LIMIT = 10;
const LOGIN_SOURCE_LIMIT = 50;

function authenticationSubjectDigest(scope: string, subject: string): string {
  return createHash("sha256").update(`${scope}\0${subject}`, "utf8").digest("hex");
}

export function registerSessionRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  signingKey: Buffer,
): void {
  app.get(
    "/api/v1/session",
    {
      schema: {
        response: {
          200: jsonSchemaForEmbedding(sessionJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    (request) => request.operatorSession,
  );

  app.post(
    "/auth/login",
    {
      bodyLimit: 1_024,
      config: PUBLIC_MUTATION_ROUTE_CONFIG,
      schema: {
        body: jsonSchemaForEmbedding(loginCommandJsonSchema),
        response: {
          200: jsonSchemaForEmbedding(sessionJsonSchema),
          400: jsonSchemaForEmbedding(apiErrorJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          413: jsonSchemaForEmbedding(apiErrorJsonSchema),
          415: jsonSchemaForEmbedding(apiErrorJsonSchema),
          429: jsonSchemaForEmbedding(apiErrorJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      const command = LoginCommandSchema.parse(request.body);
      try {
        const rateLimit = await consumeAuthenticationRateLimit(
          pool,
          [
            {
              limit: LOGIN_SOURCE_LIMIT,
              scope: "operator_login_source",
              subjectDigest: authenticationSubjectDigest("operator-login-source", request.ip),
            },
            {
              limit: LOGIN_PRINCIPAL_LIMIT,
              scope: "operator_login_principal",
              subjectDigest: authenticationSubjectDigest(
                "operator-login-principal",
                command.username,
              ),
            },
          ],
          LOGIN_RATE_LIMIT_WINDOW_SECONDS,
        );
        if (!rateLimit.allowed) {
          if (rateLimit.newlyExceededScopes.length > 0) {
            await appendAuditRecord(pool, {
              actorId: null,
              actorType: "anonymous",
              causationId: null,
              correlationId: request.id,
              denialReason: "rate_limit_exceeded",
              eventType: "operator.login.rate_limited",
              facts: {},
              outcome: "denied",
              targetId: null,
              targetType: "operator",
            });
            request.log.warn({ event: "operator.login_rate_limited" });
          }
          return await reply
            .header("Retry-After", String(rateLimit.retryAfterSeconds))
            .code(429)
            .send(
              ApiErrorSchema.parse({
                schemaVersion: 1,
                code: "RATE_LIMITED",
                message: "Operator authentication is temporarily limited",
                correlationId: request.id,
              }),
            );
        }

        const credentials = await readOperatorCredentials(pool, command.username);
        const passwordMatches = await verifyPassword(
          command.password,
          credentials?.passwordHash ?? ARGON2ID_DUMMY_HASH,
        );
        if (!credentials || !passwordMatches) {
          await appendAuditRecord(pool, {
            actorId: null,
            actorType: "anonymous",
            causationId: null,
            correlationId: request.id,
            denialReason: "invalid_credentials",
            eventType: "operator.login.denied",
            outcome: "denied",
            targetId: credentials?.id ?? null,
            targetType: "operator",
          });
          request.log.warn({ event: "operator.login_failed" });
          return await reply.code(401).send(
            ApiErrorSchema.parse({
              schemaVersion: 1,
              code: "AUTHENTICATION_FAILED",
              message: "The Operator credentials are invalid",
              correlationId: request.id,
            }),
          );
        }

        const created = createSessionToken(credentials, signingKey);
        await appendAuditRecord(pool, {
          actorId: credentials.id,
          actorType: "operator",
          causationId: null,
          correlationId: request.id,
          denialReason: null,
          eventType: "operator.login.succeeded",
          outcome: "succeeded",
          targetId: credentials.id,
          targetType: "operator",
        });
        reply.header(
          "Set-Cookie",
          serializeSessionCookie(created.token, created.session.expiresAt),
        );
        reply.header(
          "Set-Cookie",
          serializeCsrfCookie(
            createCsrfToken(created.token, signingKey),
            created.session.expiresAt,
          ),
        );
        request.log.info({ event: "operator.login_succeeded", operatorId: credentials.id });
        return created.session;
      } catch (error) {
        request.log.error({ err: error, event: "operator.login_unavailable" });
        return await reply.code(503).send(
          ApiErrorSchema.parse({
            schemaVersion: 1,
            code: "SERVICE_UNAVAILABLE",
            message: "Operator authentication is unavailable",
            correlationId: request.id,
          }),
        );
      }
    },
  );

  app.post(
    "/auth/logout",
    {
      bodyLimit: 1_024,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        body: jsonSchemaForEmbedding(logoutCommandJsonSchema),
        response: {
          204: { type: "null" },
          400: jsonSchemaForEmbedding(apiErrorJsonSchema),
          401: jsonSchemaForEmbedding(apiErrorJsonSchema),
          403: jsonSchemaForEmbedding(apiErrorJsonSchema),
          413: jsonSchemaForEmbedding(apiErrorJsonSchema),
          415: jsonSchemaForEmbedding(apiErrorJsonSchema),
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      LogoutCommandSchema.parse(request.body);
      for (const cookie of serializeClearedAuthenticationCookies()) {
        reply.header("Set-Cookie", cookie);
      }
      try {
        const session = request.operatorSession;
        if (session === null) {
          throw new Error("Authenticated logout route has no session");
        }
        await appendAuditRecord(pool, {
          actorId: session.operator.id,
          actorType: "operator",
          causationId: null,
          correlationId: request.id,
          denialReason: null,
          eventType: "operator.logout.succeeded",
          facts: {},
          outcome: "succeeded",
          targetId: session.operator.id,
          targetType: "operator",
        });
        return await reply.code(204).send();
      } catch (error) {
        request.log.error({ err: error, event: "operator.logout_audit_unavailable" });
        return await reply.code(503).send(
          ApiErrorSchema.parse({
            schemaVersion: 1,
            code: "SERVICE_UNAVAILABLE",
            message: "Operator logout audit is unavailable",
            correlationId: request.id,
          }),
        );
      }
    },
  );
}
