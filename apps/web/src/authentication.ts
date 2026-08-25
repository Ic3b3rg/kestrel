import type { FastifyInstance, FastifyRequest } from "fastify";

import { ApiErrorSchema, type Session } from "@kestrel/contracts";

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

export function registerAuthentication(app: FastifyInstance, signingKey: Buffer): void {
  app.decorateRequest("operatorSession", null);
  app.addHook("onRequest", (request, reply, done) => {
    if (isPublicRequest(request)) {
      done();
      return;
    }

    const token = readSessionCookie(request.headers.cookie);
    if (token !== null) {
      try {
        request.operatorSession = verifySessionToken(token, signingKey);
        done();
        return;
      } catch {
        // Invalid, tampered, and expired tokens all share the same public response.
      }
    }
    void reply
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
