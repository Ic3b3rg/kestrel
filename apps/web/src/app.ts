import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";

import { ApiErrorSchema } from "@kestrel/contracts";
import type { DatabasePool, DiagnosticJobSender } from "@kestrel/database";

import { registerDiagnosticRoutes } from "./routes/diagnostics.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerInstallationRoutes } from "./routes/installation.js";
import { registerOpenApiRoute } from "./routes/openapi.js";
import { registerPwaRoutes } from "./routes/pwa.js";
import { registerSessionRoutes } from "./routes/session.js";
import { registerAuthentication } from "./authentication.js";

export interface BuildAppOptions {
  boss: DiagnosticJobSender;
  eventPool?: DatabasePool;
  eventRetentionLimit: number;
  logger?: boolean;
  pool: DatabasePool;
  pwaRoot?: string;
  sessionSigningKey: Buffer;
}

interface ClassifiedApiError {
  code:
    | "INTERNAL_ERROR"
    | "INVALID_REQUEST"
    | "PAYLOAD_TOO_LARGE"
    | "REQUEST_REJECTED"
    | "UNSUPPORTED_MEDIA_TYPE";
  expected: boolean;
  message: string;
  statusCode: number;
}

function classifyApiError(error: unknown): ClassifiedApiError {
  if (typeof error !== "object" || error === null) {
    return {
      code: "INTERNAL_ERROR",
      expected: false,
      message: "Request failed",
      statusCode: 500,
    };
  }
  const validation = "validation" in error ? error.validation : undefined;
  const statusCode = "statusCode" in error ? error.statusCode : undefined;
  if (validation !== undefined || statusCode === 400) {
    return {
      code: "INVALID_REQUEST",
      expected: true,
      message: "The request does not match the API contract",
      statusCode: 400,
    };
  }
  if (statusCode === 413) {
    return {
      code: "PAYLOAD_TOO_LARGE",
      expected: true,
      message: "The request payload is too large",
      statusCode,
    };
  }
  if (statusCode === 415) {
    return {
      code: "UNSUPPORTED_MEDIA_TYPE",
      expected: true,
      message: "The request media type is unsupported",
      statusCode,
    };
  }
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
    return {
      code: "REQUEST_REJECTED",
      expected: true,
      message: "The request was rejected",
      statusCode,
    };
  }
  return {
    code: "INTERNAL_ERROR",
    expected: false,
    message: "Request failed",
    statusCode: 500,
  };
}

export async function buildApp({
  boss,
  eventRetentionLimit,
  logger = true,
  pool,
  eventPool = pool,
  pwaRoot,
  sessionSigningKey,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
    genReqId: () => randomUUID(),
    logger: logger ? { base: { service: "web" } } : false,
  });

  app.addHook("onSend", (request, reply, payload, done) => {
    if (request.url.startsWith("/api/") || request.url.startsWith("/auth/")) {
      reply.header("Cache-Control", "no-store");
    }
    done(null, payload);
  });

  app.setErrorHandler((error, request, reply) => {
    const classified = classifyApiError(error);
    if (!classified.expected) {
      request.log.error({ err: error, event: "web.request_failed" });
    }

    return reply.code(classified.statusCode).send({
      schemaVersion: 1,
      code: classified.code,
      message: classified.message,
      correlationId: request.id,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send(
        ApiErrorSchema.parse({
          schemaVersion: 1,
          code: "NOT_FOUND",
          message: "The requested API resource does not exist",
          correlationId: request.id,
        }),
      );
    }
    return reply.code(404).type("text/plain").send("Not Found");
  });

  registerAuthentication(app, sessionSigningKey);
  registerSessionRoutes(app, pool, sessionSigningKey);

  registerDiagnosticRoutes(app, pool, boss, eventRetentionLimit);
  registerEventRoutes(app, eventPool);
  registerHealthRoutes(app, pool);
  registerInstallationRoutes(app, pool);
  registerOpenApiRoute(app);
  if (pwaRoot !== undefined) {
    await registerPwaRoutes(app, pwaRoot);
  }

  return app;
}
