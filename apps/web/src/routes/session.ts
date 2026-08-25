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
import { readOperatorCredentials, type DatabasePool } from "@kestrel/database";

import { verifyPassword } from "../password.js";
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
          503: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      const command = LoginCommandSchema.parse(request.body);
      try {
        const credentials = await readOperatorCredentials(pool, command.username);
        if (!credentials || !(await verifyPassword(command.password, credentials.passwordHash))) {
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
        },
      },
    },
    (request, reply) => {
      LogoutCommandSchema.parse(request.body);
      for (const cookie of serializeClearedAuthenticationCookies()) {
        reply.header("Set-Cookie", cookie);
      }
      return reply.code(204).send();
    },
  );
}
