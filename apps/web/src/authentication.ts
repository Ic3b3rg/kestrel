import type { FastifyInstance } from "fastify";

import { ApiErrorSchema, type Session } from "@kestrel/contracts";

import { readSessionCookie, verifySessionToken } from "./session.js";

declare module "fastify" {
  interface FastifyRequest {
    operatorSession: Session | null;
  }
}

function isPublicRequest(method: string, url: string): boolean {
  if (!url.startsWith("/api/")) {
    return true;
  }
  return (
    (method === "POST" && url === "/api/v1/session") ||
    (method === "GET" && url === "/api/v1/openapi.json")
  );
}

export function registerAuthentication(app: FastifyInstance, signingKey: Buffer): void {
  app.decorateRequest("operatorSession", null);
  app.addHook("onRequest", (request, reply, done) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (isPublicRequest(request.method, path)) {
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
    void reply.code(401).send(
      ApiErrorSchema.parse({
        schemaVersion: 1,
        code: "AUTHENTICATION_REQUIRED",
        message: "Operator authentication is required",
        correlationId: request.id,
      }),
    );
  });
}
