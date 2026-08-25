import type { FastifyInstance, FastifyRequest } from "fastify";

import { ApiErrorSchema, type Session } from "@kestrel/contracts";
import { readOperatorSessionState, type DatabasePool } from "@kestrel/database";

import { readSessionCookie, verifySessionToken } from "./session.js";

declare module "fastify" {
  interface FastifyContextConfig {
    authentication?: "public";
  }

  interface FastifyRequest {
    operatorSession: Session | null;
  }
}

export const PUBLIC_ROUTE_CONFIG = { authentication: "public" } as const;

function isPublicRequest(request: FastifyRequest): boolean {
  return request.routeOptions.config.authentication === "public";
}

export function registerAuthentication(
  app: FastifyInstance,
  pool: DatabasePool,
  signingKey: Buffer,
): void {
  app.decorateRequest("operatorSession", null);
  app.addHook("onRequest", async (request, reply) => {
    if (isPublicRequest(request)) {
      return;
    }

    const token = readSessionCookie(request.headers.cookie);
    if (token !== null) {
      try {
        const verified = verifySessionToken(token, signingKey);
        const current = await readOperatorSessionState(pool, verified.session.operator.id);
        if (
          current !== null &&
          current.username === verified.session.operator.username &&
          current.credentialVersion === verified.session.credentialVersion &&
          current.sessionGeneration === verified.sessionGeneration
        ) {
          request.operatorSession = verified.session;
          return;
        }
      } catch {
        // Invalid, tampered, and expired tokens all share the same public response.
      }
    }
    return reply
      .header("Cache-Control", "no-store")
      .code(401)
      .send(
        ApiErrorSchema.parse({
          schemaVersion: 1,
          code: "AUTHENTICATION_REQUIRED",
          message: "Operator authentication is required",
          correlationId: request.id,
        }),
      );
  });
}
