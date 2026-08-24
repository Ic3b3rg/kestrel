import type { FastifyInstance } from "fastify";

import { openApiDocument } from "@kestrel/contracts";

export function registerOpenApiRoute(app: FastifyInstance): void {
  app.get(
    "/api/v1/openapi.json",
    { schema: { response: { 200: { additionalProperties: true, type: "object" } } } },
    () => openApiDocument,
  );
}
