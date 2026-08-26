import { z, type ZodType } from "zod";

import {
  ApiErrorSchema,
  CredentialChangeCommandSchema,
  DiagnosticAcceptedSchema,
  DiagnosticCommandSchema,
  EventCursorSchema,
  HealthStatusSchema,
  InstallationEventSchema,
  InstallationSnapshotSchema,
  LoginCommandSchema,
  LogoutCommandSchema,
  OpenPublicGitHubPullRequestCommandSchema,
  ProjectInboxSchema,
  ProjectUpsertedSchema,
  SessionSchema,
  StepUpCommandSchema,
  StepUpProofSchema,
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
export const logoutCommandJsonSchema = asJsonSchema(LogoutCommandSchema);
export const sessionJsonSchema = asJsonSchema(SessionSchema);
export const stepUpCommandJsonSchema = asJsonSchema(StepUpCommandSchema);
export const stepUpProofJsonSchema = asJsonSchema(StepUpProofSchema);
export const credentialChangeCommandJsonSchema = asJsonSchema(CredentialChangeCommandSchema);
export const openPublicGitHubPullRequestCommandJsonSchema = asJsonSchema(
  OpenPublicGitHubPullRequestCommandSchema,
);
export const projectInboxJsonSchema = asJsonSchema(ProjectInboxSchema);
export const projectUpsertedJsonSchema = asJsonSchema(ProjectUpsertedSchema);

export const contractBundle = sortJson({
  $defs: {
    ApiError: asComponentSchema(apiErrorJsonSchema),
    DiagnosticAccepted: asComponentSchema(diagnosticAcceptedJsonSchema),
    DiagnosticCommand: asComponentSchema(diagnosticCommandJsonSchema),
    InstallationEvent: asComponentSchema(installationEventJsonSchema),
    InstallationSnapshot: asComponentSchema(installationSnapshotJsonSchema),
    CredentialChangeCommand: asComponentSchema(credentialChangeCommandJsonSchema),
    LoginCommand: asComponentSchema(loginCommandJsonSchema),
    LogoutCommand: asComponentSchema(logoutCommandJsonSchema),
    OpenPublicGitHubPullRequestCommand: asComponentSchema(
      openPublicGitHubPullRequestCommandJsonSchema,
    ),
    ProjectInbox: asComponentSchema(projectInboxJsonSchema),
    ProjectUpserted: asComponentSchema(projectUpsertedJsonSchema),
    Session: asComponentSchema(sessionJsonSchema),
    StepUpCommand: asComponentSchema(stepUpCommandJsonSchema),
    StepUpProof: asComponentSchema(stepUpProofJsonSchema),
  },
  $id: "https://kestrel.local/schemas/v1.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Kestrel API V1 contracts",
  type: "object",
}) as JsonObject;

const schemaReference = (name: string): JsonObject => ({
  $ref: `#/components/schemas/${name}`,
});

function publicMutationHeaders(): JsonValue[] {
  return [
    {
      in: "header",
      name: "Origin",
      required: true,
      schema: { format: "uri", type: "string" },
    },
  ];
}

function authenticatedMutationHeaders(includeStepUp: boolean): JsonValue[] {
  const headers: JsonValue[] = [
    ...publicMutationHeaders(),
    {
      in: "header",
      name: "X-Kestrel-CSRF",
      required: true,
      schema: { minLength: 1, type: "string" },
    },
  ];
  if (includeStepUp) {
    headers.push({
      in: "header",
      name: "X-Kestrel-Step-Up",
      required: true,
      schema: { pattern: "^[A-Za-z0-9_-]{43}$", type: "string" },
    });
  }
  return headers;
}

export const openApiDocument = sortJson({
  components: {
    schemas: {
      ApiError: asComponentSchema(apiErrorJsonSchema),
      DiagnosticAccepted: asComponentSchema(diagnosticAcceptedJsonSchema),
      DiagnosticCommand: asComponentSchema(diagnosticCommandJsonSchema),
      HealthStatus: asComponentSchema(healthStatusJsonSchema),
      InstallationEvent: asComponentSchema(installationEventJsonSchema),
      InstallationSnapshot: asComponentSchema(installationSnapshotJsonSchema),
      CredentialChangeCommand: asComponentSchema(credentialChangeCommandJsonSchema),
      LoginCommand: asComponentSchema(loginCommandJsonSchema),
      LogoutCommand: asComponentSchema(logoutCommandJsonSchema),
      OpenPublicGitHubPullRequestCommand: asComponentSchema(
        openPublicGitHubPullRequestCommandJsonSchema,
      ),
      ProjectInbox: asComponentSchema(projectInboxJsonSchema),
      ProjectUpserted: asComponentSchema(projectUpsertedJsonSchema),
      Session: asComponentSchema(sessionJsonSchema),
      StepUpCommand: asComponentSchema(stepUpCommandJsonSchema),
      StepUpProof: asComponentSchema(stepUpProofJsonSchema),
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
          "401": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "Operator authentication is required",
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
          "401": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "Operator authentication is required",
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
        parameters: authenticatedMutationHeaders(false),
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
          "401": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "Operator authentication is required",
          },
          "403": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "Origin or CSRF validation failed",
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
    "/auth/login": {
      post: {
        operationId: "createOperatorSession",
        parameters: publicMutationHeaders(),
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
          "403": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "Origin validation failed",
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
          "429": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "The release-fixed Operator login limit was reached",
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
    "/auth/logout": {
      post: {
        operationId: "deleteOperatorSessionCookie",
        parameters: authenticatedMutationHeaders(false),
        requestBody: {
          content: {
            "application/json": { schema: schemaReference("LogoutCommand") },
          },
          required: true,
        },
        responses: {
          "204": { description: "Current browser cookies cleared" },
          "400": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Invalid logout request",
          },
          "401": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Operator authentication is required",
          },
          "403": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Origin or CSRF validation failed",
          },
          "413": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The logout request is too large",
          },
          "415": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The logout media type is unsupported",
          },
          "503": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The logout audit dependency is unavailable",
          },
        },
      },
    },
    "/auth/step-up": {
      post: {
        operationId: "createOperatorStepUpProof",
        parameters: authenticatedMutationHeaders(false),
        requestBody: {
          content: {
            "application/json": { schema: schemaReference("StepUpCommand") },
          },
          required: true,
        },
        responses: {
          "200": {
            content: { "application/json": { schema: schemaReference("StepUpProof") } },
            description: "One-command step-up proof created",
          },
          "400": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Invalid step-up request",
          },
          "401": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Operator authentication is required",
          },
          "403": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Step-up credentials, Origin, or CSRF validation failed",
          },
          "429": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The release-fixed step-up limit was reached",
          },
          "413": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The step-up request is too large",
          },
          "415": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The step-up media type is unsupported",
          },
          "503": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Step-up authentication is unavailable",
          },
        },
      },
    },
    "/api/v1/operator/credentials": {
      post: {
        operationId: "changeOperatorCredentials",
        parameters: authenticatedMutationHeaders(true),
        requestBody: {
          content: {
            "application/json": { schema: schemaReference("CredentialChangeCommand") },
          },
          required: true,
        },
        responses: {
          "204": { description: "Credentials changed and all browser cookies cleared" },
          "400": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Invalid credential change request",
          },
          "401": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Operator authentication is required",
          },
          "403": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Step-up proof, Origin, or CSRF validation failed",
          },
          "409": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Credential version conflict",
          },
          "413": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The credential change request is too large",
          },
          "415": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The credential change media type is unsupported",
          },
          "429": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The release-fixed credential-change limit was reached",
          },
          "503": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Credential storage is unavailable",
          },
        },
      },
    },
    "/api/v1/projects": {
      get: {
        operationId: "readProjectInbox",
        responses: {
          "200": {
            content: { "application/json": { schema: schemaReference("ProjectInbox") } },
            description: "Current Project inbox",
          },
          "401": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Operator authentication is required",
          },
          "503": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Project storage is unavailable",
          },
        },
      },
      post: {
        description:
          "Opens or manually refreshes one canonical public GitHub pull request without credentials.",
        operationId: "openPublicGitHubPullRequest",
        parameters: authenticatedMutationHeaders(false),
        requestBody: {
          content: {
            "application/json": {
              schema: schemaReference("OpenPublicGitHubPullRequestCommand"),
            },
          },
          required: true,
        },
        responses: {
          "200": {
            content: { "application/json": { schema: schemaReference("ProjectUpserted") } },
            description: "Public GitHub Project opened or refreshed idempotently",
          },
          "400": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The pull-request URL is not canonical",
          },
          "401": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Operator authentication is required",
          },
          "403": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Origin or CSRF validation failed",
          },
          "404": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The public pull request is unavailable",
          },
          "413": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The command payload is too large",
          },
          "415": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The command media type is unsupported",
          },
          "429": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "GitHub's public API limit was reached",
          },
          "503": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Public GitHub or Project storage is unavailable",
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
          "401": {
            content: {
              "application/json": { schema: schemaReference("ApiError") },
            },
            description: "Operator authentication is required",
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
