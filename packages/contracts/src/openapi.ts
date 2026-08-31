import { z, type ZodType } from "zod";

import {
  ApiErrorSchema,
  ChangeIntentVersionCreatedSchema,
  CreateChangeIntentVersionCommandSchema,
  CredentialChangeCommandSchema,
  DiagnosticAcceptedSchema,
  DiagnosticCommandSchema,
  EventCursorSchema,
  HealthStatusSchema,
  HostGitHubProjectInboxSchema,
  InstallationEventSchema,
  InstallationSnapshotSchema,
  LoginCommandSchema,
  LogoutCommandSchema,
  LocalRepositoryInventorySchema,
  LocalRepositoryReferencesSchema,
  OpenPublicGitHubPullRequestCommandSchema,
  ObserveHostGitHubPullRequestCommandSchema,
  ProjectInboxSchema,
  ProjectUpsertedSchema,
  RetainReviewRevisionCommandSchema,
  ReviewPreparationSchema,
  ReviewRevisionAvailableSchema,
  ReviewWorkflowAcceptedSchema,
  SessionSchema,
  StartReviewWorkflowCommandSchema,
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
export const createChangeIntentVersionCommandJsonSchema = asJsonSchema(
  CreateChangeIntentVersionCommandSchema,
);
export const changeIntentVersionCreatedJsonSchema = asJsonSchema(ChangeIntentVersionCreatedSchema);
export const openPublicGitHubPullRequestCommandJsonSchema = asJsonSchema(
  OpenPublicGitHubPullRequestCommandSchema,
);
export const projectInboxJsonSchema = asJsonSchema(ProjectInboxSchema);
export const projectUpsertedJsonSchema = asJsonSchema(ProjectUpsertedSchema);
export const hostGitHubProjectInboxJsonSchema = asJsonSchema(HostGitHubProjectInboxSchema);
export const observeHostGitHubPullRequestCommandJsonSchema = asJsonSchema(
  ObserveHostGitHubPullRequestCommandSchema,
);
export const localRepositoryInventoryJsonSchema = asJsonSchema(LocalRepositoryInventorySchema);
export const localRepositoryReferencesJsonSchema = asJsonSchema(LocalRepositoryReferencesSchema);
export const retainReviewRevisionCommandJsonSchema = asJsonSchema(
  RetainReviewRevisionCommandSchema,
);
export const reviewRevisionAvailableJsonSchema = asJsonSchema(ReviewRevisionAvailableSchema);
export const reviewPreparationJsonSchema = asJsonSchema(ReviewPreparationSchema);
export const reviewWorkflowAcceptedJsonSchema = asJsonSchema(ReviewWorkflowAcceptedSchema);
export const startReviewWorkflowCommandJsonSchema = asJsonSchema(StartReviewWorkflowCommandSchema);

export const contractBundle = sortJson({
  $defs: {
    ApiError: asComponentSchema(apiErrorJsonSchema),
    DiagnosticAccepted: asComponentSchema(diagnosticAcceptedJsonSchema),
    DiagnosticCommand: asComponentSchema(diagnosticCommandJsonSchema),
    InstallationEvent: asComponentSchema(installationEventJsonSchema),
    InstallationSnapshot: asComponentSchema(installationSnapshotJsonSchema),
    CredentialChangeCommand: asComponentSchema(credentialChangeCommandJsonSchema),
    CreateChangeIntentVersionCommand: asComponentSchema(createChangeIntentVersionCommandJsonSchema),
    ChangeIntentVersionCreated: asComponentSchema(changeIntentVersionCreatedJsonSchema),
    LoginCommand: asComponentSchema(loginCommandJsonSchema),
    LogoutCommand: asComponentSchema(logoutCommandJsonSchema),
    OpenPublicGitHubPullRequestCommand: asComponentSchema(
      openPublicGitHubPullRequestCommandJsonSchema,
    ),
    ProjectInbox: asComponentSchema(projectInboxJsonSchema),
    ProjectUpserted: asComponentSchema(projectUpsertedJsonSchema),
    HostGitHubProjectInbox: asComponentSchema(hostGitHubProjectInboxJsonSchema),
    ObserveHostGitHubPullRequestCommand: asComponentSchema(
      observeHostGitHubPullRequestCommandJsonSchema,
    ),
    LocalRepositoryInventory: asComponentSchema(localRepositoryInventoryJsonSchema),
    LocalRepositoryReferences: asComponentSchema(localRepositoryReferencesJsonSchema),
    RetainReviewRevisionCommand: asComponentSchema(retainReviewRevisionCommandJsonSchema),
    ReviewRevisionAvailable: asComponentSchema(reviewRevisionAvailableJsonSchema),
    ReviewPreparation: asComponentSchema(reviewPreparationJsonSchema),
    ReviewWorkflowAccepted: asComponentSchema(reviewWorkflowAcceptedJsonSchema),
    StartReviewWorkflowCommand: asComponentSchema(startReviewWorkflowCommandJsonSchema),
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
      CreateChangeIntentVersionCommand: asComponentSchema(
        createChangeIntentVersionCommandJsonSchema,
      ),
      ChangeIntentVersionCreated: asComponentSchema(changeIntentVersionCreatedJsonSchema),
      LoginCommand: asComponentSchema(loginCommandJsonSchema),
      LogoutCommand: asComponentSchema(logoutCommandJsonSchema),
      OpenPublicGitHubPullRequestCommand: asComponentSchema(
        openPublicGitHubPullRequestCommandJsonSchema,
      ),
      ProjectInbox: asComponentSchema(projectInboxJsonSchema),
      ProjectUpserted: asComponentSchema(projectUpsertedJsonSchema),
      HostGitHubProjectInbox: asComponentSchema(hostGitHubProjectInboxJsonSchema),
      ObserveHostGitHubPullRequestCommand: asComponentSchema(
        observeHostGitHubPullRequestCommandJsonSchema,
      ),
      LocalRepositoryInventory: asComponentSchema(localRepositoryInventoryJsonSchema),
      LocalRepositoryReferences: asComponentSchema(localRepositoryReferencesJsonSchema),
      RetainReviewRevisionCommand: asComponentSchema(retainReviewRevisionCommandJsonSchema),
      ReviewRevisionAvailable: asComponentSchema(reviewRevisionAvailableJsonSchema),
      ReviewPreparation: asComponentSchema(reviewPreparationJsonSchema),
      ReviewWorkflowAccepted: asComponentSchema(reviewWorkflowAcceptedJsonSchema),
      StartReviewWorkflowCommand: asComponentSchema(startReviewWorkflowCommandJsonSchema),
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
    "/api/v1/local-repository-sources": {
      get: {
        operationId: "listLocalRepositorySources",
        responses: {
          "200": {
            content: {
              "application/json": { schema: schemaReference("LocalRepositoryInventory") },
            },
            description: "Bounded authorized local repository inventory",
          },
          "401": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Operator authentication is required",
          },
          "413": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The configured repository discovery limit was reached",
          },
          "503": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Local repository discovery is unavailable",
          },
        },
      },
    },
    "/api/v1/local-repository-sources/{repositoryId}/references": {
      get: {
        operationId: "listLocalRepositoryReferences",
        parameters: [
          {
            in: "path",
            name: "repositoryId",
            required: true,
            schema: {
              format: "uuid",
              pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
              type: "string",
            },
          },
        ],
        responses: {
          "200": {
            content: {
              "application/json": { schema: schemaReference("LocalRepositoryReferences") },
            },
            description: "Bounded committed reference inventory",
          },
          "400": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Invalid opaque repository identity",
          },
          "401": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Operator authentication is required",
          },
          "404": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Repository is no longer available",
          },
          "413": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The configured reference inventory limit was reached",
          },
          "422": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Repository containment validation failed",
          },
          "503": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Git inspection is unavailable",
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
    "/api/v1/projects/{projectId}/change-proposals/{changeProposalId}/change-intents": {
      post: {
        description:
          "Creates one immutable Change Intent version. The expected Proposal version makes duplicate or stale submissions fail closed.",
        operationId: "createChangeIntentVersion",
        parameters: [
          ...authenticatedMutationHeaders(false),
          {
            in: "path",
            name: "projectId",
            required: true,
            schema: { format: "uuid", type: "string" },
          },
          {
            in: "path",
            name: "changeProposalId",
            required: true,
            schema: { format: "uuid", type: "string" },
          },
        ],
        requestBody: {
          content: {
            "application/json": { schema: schemaReference("CreateChangeIntentVersionCommand") },
          },
          required: true,
        },
        responses: {
          "201": {
            content: {
              "application/json": { schema: schemaReference("ChangeIntentVersionCreated") },
            },
            description: "Immutable Change Intent version created",
          },
          "400": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Invalid structured Change Intent command",
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
            description: "Project or Change Proposal is unavailable",
          },
          "409": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Proposal version or selected-source conflict",
          },
          "413": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The command payload is too large",
          },
          "415": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The command media type is unsupported",
          },
          "500": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The Change Intent version could not be created atomically",
          },
        },
      },
    },
    "/api/v1/projects/{projectId}/change-proposals/{changeProposalId}/review-preparation": {
      get: {
        description:
          "Reads the exact retained Review inputs and all blockers without starting work or refreshing any source.",
        operationId: "readReviewPreparation",
        parameters: [
          {
            in: "path",
            name: "projectId",
            required: true,
            schema: { format: "uuid", type: "string" },
          },
          {
            in: "path",
            name: "changeProposalId",
            required: true,
            schema: { format: "uuid", type: "string" },
          },
        ],
        responses: {
          "200": {
            content: { "application/json": { schema: schemaReference("ReviewPreparation") } },
            description: "Current exact Review preparation and blockers",
          },
          "400": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Invalid Project or Change Proposal identity",
          },
          "401": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Operator authentication is required",
          },
          "404": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Project or Change Proposal is unavailable",
          },
          "503": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Review preparation storage is unavailable",
          },
        },
      },
    },
    "/api/v1/projects/{projectId}/change-proposals/{changeProposalId}/review-workflows": {
      post: {
        description:
          "Transactionally rechecks and freezes the exact inputs identified by a server-issued preparation digest.",
        operationId: "startReviewWorkflow",
        parameters: [
          ...authenticatedMutationHeaders(false),
          {
            in: "path",
            name: "projectId",
            required: true,
            schema: { format: "uuid", type: "string" },
          },
          {
            in: "path",
            name: "changeProposalId",
            required: true,
            schema: { format: "uuid", type: "string" },
          },
        ],
        requestBody: {
          content: {
            "application/json": { schema: schemaReference("StartReviewWorkflowCommand") },
          },
          required: true,
        },
        responses: {
          "202": {
            content: {
              "application/json": { schema: schemaReference("ReviewWorkflowAccepted") },
            },
            description: "Review Workflow inputs frozen and queued",
          },
          "400": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Invalid Review command",
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
            description: "Project or Change Proposal is unavailable",
          },
          "409": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Review inputs are blocked or changed after preparation",
          },
          "413": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The command payload is too large",
          },
          "415": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The command media type is unsupported",
          },
          "500": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The Review Workflow could not be started atomically",
          },
        },
      },
    },
    "/api/v1/projects/{projectId}/provider/github": {
      get: {
        description:
          "Reads a bounded Project-scoped pull-request inbox through the Operator workstation's existing gh session.",
        operationId: "readHostGitHubProjectInbox",
        parameters: [
          {
            in: "path",
            name: "projectId",
            required: true,
            schema: { format: "uuid", type: "string" },
          },
        ],
        responses: {
          "200": {
            content: { "application/json": { schema: schemaReference("HostGitHubProjectInbox") } },
            description: "Attributed host GitHub pull-request inbox",
          },
          "400": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Invalid Project identity",
          },
          "401": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Operator authentication is required",
          },
          "404": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Project has no supported attached GitHub source",
          },
          "503": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Host GitHub observation is unavailable",
          },
        },
      },
    },
    "/api/v1/projects/{projectId}/provider/github/pull-requests/observe": {
      post: {
        description:
          "Manually records one exact host-gh pull-request observation on the same local Project.",
        operationId: "observeHostGitHubPullRequest",
        parameters: [
          {
            in: "path",
            name: "projectId",
            required: true,
            schema: { format: "uuid", type: "string" },
          },
          ...authenticatedMutationHeaders(false),
        ],
        requestBody: {
          content: {
            "application/json": { schema: schemaReference("ObserveHostGitHubPullRequestCommand") },
          },
          required: true,
        },
        responses: {
          "200": {
            content: { "application/json": { schema: schemaReference("ProjectUpserted") } },
            description: "Provider observation recorded",
          },
          "400": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Invalid observation command",
          },
          "401": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Operator authentication is required",
          },
          "403": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Origin or CSRF validation failed",
          },
          "503": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Host GitHub observation is unavailable",
          },
        },
      },
    },
    "/api/v1/review-revisions": {
      post: {
        operationId: "retainReviewRevision",
        parameters: authenticatedMutationHeaders(false),
        requestBody: {
          content: {
            "application/json": { schema: schemaReference("RetainReviewRevisionCommand") },
          },
          required: true,
        },
        responses: {
          "200": {
            content: {
              "application/json": { schema: schemaReference("ReviewRevisionAvailable") },
            },
            description: "Exact Review Revision was already available",
          },
          "201": {
            content: {
              "application/json": { schema: schemaReference("ReviewRevisionAvailable") },
            },
            description: "Exact Review Revision retained and verified",
          },
          "400": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Invalid acquisition command",
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
            description: "Repository, reference, or object is unavailable",
          },
          "409": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Exact revision is acquiring or proposal selection does not match",
          },
          "413": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Command or retained revision exceeds a configured bound",
          },
          "415": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "The command media type is unsupported",
          },
          "422": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Source containment or object verification failed",
          },
          "503": {
            content: { "application/json": { schema: schemaReference("ApiError") } },
            description: "Revision storage is unavailable",
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
