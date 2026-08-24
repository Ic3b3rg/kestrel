import { z, type ZodType } from "zod";

import {
  ApiErrorSchema,
  DiagnosticAcceptedSchema,
  DiagnosticCommandSchema,
  EventCursorSchema,
  HealthStatusSchema,
  InstallationEventSchema,
  InstallationSnapshotSchema,
  LoginCommandSchema,
  SessionSchema,
} from "./v1.js";

type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

function asJsonSchema(schema: ZodType): JsonObject {
  return z.toJSONSchema(schema, { target: "draft-2020-12" }) as JsonObject;
}

function asComponentSchema(schema: JsonObject): JsonObject {
  const component = { ...schema };
  delete component.$schema;
  return component;
}

export function jsonSchemaForEmbedding(schema: JsonObject): JsonObject {
  return asComponentSchema(schema);
}

export function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }

  return value;
}

export function serializeJson(value: JsonValue): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

export const installationSnapshotJsonSchema = asJsonSchema(InstallationSnapshotSchema);
export const diagnosticAcceptedJsonSchema = asJsonSchema(DiagnosticAcceptedSchema);
export const diagnosticCommandJsonSchema = asJsonSchema(DiagnosticCommandSchema);
export const installationEventJsonSchema = asJsonSchema(InstallationEventSchema);
export const apiErrorJsonSchema = asJsonSchema(ApiErrorSchema);
export const healthStatusJsonSchema = asJsonSchema(HealthStatusSchema);
export const eventCursorJsonSchema = asJsonSchema(EventCursorSchema);
export const loginCommandJsonSchema = asJsonSchema(LoginCommandSchema);
export const sessionJsonSchema = asJsonSchema(SessionSchema);

export const contractBundle = sortJson({
  $defs: {
    ApiError: asComponentSchema(apiErrorJsonSchema),
    DiagnosticAccepted: asComponentSchema(diagnosticAcceptedJsonSchema),
    DiagnosticCommand: asComponentSchema(diagnosticCommandJsonSchema),
    InstallationEvent: asComponentSchema(installationEventJsonSchema),
    InstallationSnapshot: asComponentSchema(installationSnapshotJsonSchema),
    LoginCommand: asComponentSchema(loginCommandJsonSchema),
    Session: asComponentSchema(sessionJsonSchema),
  },
  $id: "https://kestrel.local/schemas/v1.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Kestrel API V1 contracts",
  type: "object",
}) as JsonObject;

const schemaReference = (name: string): JsonObject => ({
  $ref: `#/components/schemas/${name}`,
});

export const openApiDocument = sortJson({
  components: {
    schemas: {
      ApiError: asComponentSchema(apiErrorJsonSchema),
      DiagnosticAccepted: asComponentSchema(diagnosticAcceptedJsonSchema),
      DiagnosticCommand: asComponentSchema(diagnosticCommandJsonSchema),
      HealthStatus: asComponentSchema(healthStatusJsonSchema),
      InstallationEvent: asComponentSchema(installationEventJsonSchema),
      InstallationSnapshot: asComponentSchema(installationSnapshotJsonSchema),
      LoginCommand: asComponentSchema(loginCommandJsonSchema),
      Session: asComponentSchema(sessionJsonSchema),
    },
  },
  info: {
    title: "Kestrel private API",
    version: "1.0.0",
  },
  jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
  openapi: "3.1.1",
  paths: {
    "/api/v1/events": {
      get: {
        operationId: "streamInstallationEvents",
        parameters: [
          {
            in: "header",
            name: "Last-Event-ID",
            required: false,
            schema: asComponentSchema(eventCursorJsonSchema),
          },
          {
            in: "query",
            name: "after",
            required: false,
            schema: asComponentSchema(eventCursorJsonSchema),
          },
        ],
        responses: {
          "200": {
            content: {
              "text/event-stream": {
                schema: { type: "string" },
              },
            },
            description: "Ordered Installation event stream",
          },
          "400": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "Invalid or future event cursor",
          },
          "409": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "The requested event cursor is outside retention",
          },
          "500": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "The event stream could not be opened",
          },
        },
      },
    },
    "/api/v1/installation": {
      get: {
        operationId: "readInstallation",
        responses: {
          "200": {
            content: {
              "application/json": { schema: schemaReference("InstallationSnapshot") },
            },
            description: "Current authoritative Installation snapshot",
          },
          "503": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "Installation storage is unavailable",
          },
        },
      },
    },
    "/api/v1/installation/diagnostics": {
      post: {
        description:
          "Each accepted request creates a new diagnostic. Clients must not retry this command automatically.",
        operationId: "runInstallationDiagnostic",
        requestBody: {
          content: {
            "application/json": { schema: schemaReference("DiagnosticCommand") },
          },
          required: true,
        },
        responses: {
          "202": {
            content: {
              "application/json": { schema: schemaReference("DiagnosticAccepted") },
            },
            description: "Diagnostic accepted durably",
          },
          "400": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "Invalid command",
          },
          "409": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "The Installation cannot accept this transition",
          },
          "413": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "The command payload is too large",
          },
          "415": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "The command media type is unsupported",
          },
          "500": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "The diagnostic could not be accepted atomically",
          },
          "503": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "The diagnostic dependency is unavailable",
          },
        },
      },
    },
    "/api/v1/session": {
      get: {
        operationId: "readOperatorSession",
        responses: {
          "200": {
            content: {
              "application/json": { schema: schemaReference("Session") },
            },
            description: "Current authenticated Operator session",
          },
          "401": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "Operator authentication is required",
          },
        },
      },
      post: {
        operationId: "createOperatorSession",
        requestBody: {
          content: {
            "application/json": { schema: schemaReference("LoginCommand") },
          },
          required: true,
        },
        responses: {
          "200": {
            content: {
              "application/json": { schema: schemaReference("Session") },
            },
            description: "Operator authenticated for seven days",
          },
          "400": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "Invalid login request",
          },
          "401": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "Invalid Operator credentials",
          },
          "413": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "The login request is too large",
          },
          "415": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "The login media type is unsupported",
          },
          "503": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "Operator authentication is unavailable",
          },
        },
      },
    },
    "/api/v1/openapi.json": {
      get: {
        operationId: "readOpenApiDocument",
        responses: {
          "200": {
            content: {
              "application/json": { schema: { type: "object" } },
            },
            description: "Generated OpenAPI document",
          },
        },
      },
    },
    "/health/live": {
      get: {
        operationId: "readLiveness",
        responses: {
          "200": {
            content: {
              "application/json": { schema: schemaReference("HealthStatus") },
            },
            description: "Process liveness",
          },
        },
      },
    },
    "/health/ready": {
      get: {
        operationId: "readReadiness",
        responses: {
          "200": {
            content: {
              "application/json": { schema: schemaReference("HealthStatus") },
            },
            description: "Database-backed readiness",
          },
          "503": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "Database readiness is unavailable",
          },
        },
      },
    },
  },
}) as JsonObject;

export const generatedArtifacts = {
  "openapi-v1.json": serializeJson(openApiDocument),
  "schema-v1.json": serializeJson(contractBundle),
} as const;
