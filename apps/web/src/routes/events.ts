import type { FastifyInstance } from "fastify";

import { ApiErrorSchema, apiErrorJsonSchema, jsonSchemaForEmbedding } from "@kestrel/contracts";
import {
  InvalidEventCursorError,
  parseEventCursor,
  validateCursor,
  type DatabasePool,
  type EventCursorValidation,
} from "@kestrel/database";

import { startInstallationEventStream } from "../sse.js";

interface EventHeaders {
  "last-event-id"?: string;
}

interface EventQuery {
  after?: string;
}

function cursorExpiredError(correlationId: string, validation: EventCursorValidation) {
  if (validation.valid) {
    throw new Error("Cannot create an expiry response for a valid cursor");
  }
  return ApiErrorSchema.parse({
    schemaVersion: 1,
    code: "EVENT_CURSOR_EXPIRED",
    message: "The event cursor is outside retained history",
    correlationId,
    firstAvailableEventId: validation.firstAvailable,
    refetch: "/api/v1/installation",
  });
}

export function registerEventRoutes(app: FastifyInstance, pool: DatabasePool): void {
  app.get<{ Headers: EventHeaders; Querystring: EventQuery }>(
    "/api/v1/events",
    {
      schema: {
        headers: {
          properties: { "last-event-id": { type: "string" } },
          type: "object",
        },
        querystring: {
          additionalProperties: false,
          properties: { after: { type: "string" } },
          type: "object",
        },
        response: {
          400: jsonSchemaForEmbedding(apiErrorJsonSchema),
          409: jsonSchemaForEmbedding(apiErrorJsonSchema),
          500: jsonSchemaForEmbedding(apiErrorJsonSchema),
        },
      },
    },
    async (request, reply) => {
      let cursor: string;
      let initialValidation: EventCursorValidation;
      try {
        cursor = parseEventCursor(request.headers["last-event-id"] ?? request.query.after ?? "0");
        initialValidation = await validateCursor(pool, cursor);
      } catch (error) {
        if (!(error instanceof InvalidEventCursorError)) {
          throw error;
        }
        reply.code(400);
        return ApiErrorSchema.parse({
          schemaVersion: 1,
          code: "INVALID_REQUEST",
          message: error.message,
          correlationId: request.id,
        });
      }

      if (!initialValidation.valid) {
        reply.code(409);
        return cursorExpiredError(request.id, initialValidation);
      }

      const result = await startInstallationEventStream({ cursor, pool, reply, request });
      if (!result.streaming) {
        reply.code(409);
        return cursorExpiredError(request.id, result);
      }
      return reply;
    },
  );
}
