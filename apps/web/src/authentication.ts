import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ApiErrorSchema, type CredentialVersion, type Session } from "@kestrel/contracts";
import { readOperatorSessionState, type DatabasePool } from "@kestrel/database";

import {
  CSRF_HEADER_NAME,
  readCsrfCookie,
  readSessionCookie,
  verifyCsrfToken,
  verifySessionToken,
} from "./session.js";

declare module "fastify" {
  interface FastifyContextConfig {
    authentication?: "public";
    mutationProtection?: "origin" | "origin-and-csrf";
  }

  interface FastifyRequest {
    operatorSession: Session | null;
    operatorSessionGeneration: CredentialVersion | null;
  }
}

export const PUBLIC_ROUTE_CONFIG = { authentication: "public" } as const;
export const PUBLIC_MUTATION_ROUTE_CONFIG = {
  authentication: "public",
  mutationProtection: "origin",
} as const;
export const AUTHENTICATED_MUTATION_ROUTE_CONFIG = {
  mutationProtection: "origin-and-csrf",
} as const;

function isPublicRequest(request: FastifyRequest): boolean {
  return request.routeOptions.config.authentication === "public";
}

function isSameOrigin(request: FastifyRequest): boolean {
  const originHeader = request.headers.origin;
  const targetHost = request.headers.host;
  if (typeof originHeader !== "string" || targetHost === undefined) {
    return false;
  }
  try {
    const origin = new URL(originHeader);
    const loopback =
      origin.hostname === "localhost" ||
      origin.hostname === "127.0.0.1" ||
      origin.hostname === "[::1]";
    return (
      origin.origin === originHeader &&
      origin.host.toLowerCase() === targetHost.toLowerCase() &&
      (origin.protocol === "https:" || (loopback && origin.protocol === "http:"))
    );
  } catch {
    return false;
  }
}

function rejectMutation(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(403).send(
    ApiErrorSchema.parse({
      schemaVersion: 1,
      code: "REQUEST_REJECTED",
      message: "The request was rejected",
      correlationId: request.id,
    }),
  );
}

export function registerAuthentication(
  app: FastifyInstance,
  pool: DatabasePool,
  signingKey: Buffer,
): void {
  app.decorateRequest("operatorSession", null);
  app.decorateRequest("operatorSessionGeneration", null);
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
          request.operatorSessionGeneration = verified.sessionGeneration;
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

  app.addHook("onRequest", (request, reply, done) => {
    const protection = request.routeOptions.config.mutationProtection;
    if (protection === undefined) {
      done();
      return;
    }
    if (!isSameOrigin(request)) {
      void rejectMutation(request, reply);
      return;
    }
    if (protection === "origin-and-csrf") {
      const sessionToken = readSessionCookie(request.headers.cookie);
      const csrfHeader = request.headers[CSRF_HEADER_NAME];
      if (
        sessionToken === null ||
        !verifyCsrfToken(
          {
            cookieToken: readCsrfCookie(request.headers.cookie),
            headerToken: typeof csrfHeader === "string" ? csrfHeader : null,
            sessionToken,
          },
          signingKey,
        )
      ) {
        void rejectMutation(request, reply);
        return;
      }
    }
    done();
  });
}
