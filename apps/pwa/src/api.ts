import { createParser } from "eventsource-parser";

import {
  ApiErrorSchema,
  CreateFeatureCommandSchema,
  FeatureSchema,
  FeatureListSchema,
  FeatureChatSchema,
  PlanningTurnAcceptedSchema,
  SendPlanningMessageCommandSchema,
  RetryPlanningTurnCommandSchema,
  FeaturePlansSchema,
  FeaturePlanVersionSchema,
  FactoryBoardSchema,
  FactoryGitHubIssuesSchema,
  FactoryIssueImportsSchema,
  FactoryIssuePublicationSchema,
  ImportFactoryIssuesCommandSchema,
  RetryFactoryPublicationCommandSchema,
  SaveFeaturePlanCommandSchema,
  GenerateFeaturePlanCommandSchema,
  ApproveFeaturePlanCommandSchema,
  CancelFeatureCommandSchema,
  ChangeIntentVersionCreatedSchema,
  CodexReviewModelPreferenceSchema,
  CodexSubscriptionConnectionSchema,
  ConfigureDirectApiProfileCommandSchema,
  CreateChangeIntentVersionCommandSchema,
  CredentialChangeCommandSchema,
  DiagnosticAcceptedSchema,
  DirectApiProfileResponseSchema,
  EventCursorSchema,
  InstallationEventSchema,
  InstallationSnapshotSchema,
  KestrelIdSchema,
  HostGitHubConnectionSchema,
  HostGitHubProjectInboxSchema,
  ObserveHostGitHubPullRequestCommandSchema,
  LoginCommandSchema,
  OpenLocalProjectCommandSchema,
  OpenPublicGitHubPullRequestCommandSchema,
  LocalRepositoryInventorySchema,
  LocalRepositoryReferencesSchema,
  ProjectInboxSchema,
  ProjectUpsertedSchema,
  RetainReviewRevisionCommandSchema,
  ReviewPreparationSchema,
  ReviewRevisionAvailableSchema,
  ReviewWorkflowAcceptedSchema,
  serializeCredentialChangeCommand,
  serializeConfigureDirectApiProfileCommand,
  SessionSchema,
  SelectCodexReviewModelCommandSchema,
  StepUpCommandSchema,
  StepUpProofSchema,
  StartReviewWorkflowCommandSchema,
  type ApiError,
  type CreateFeatureCommand,
  type Feature,
  type FeatureChat,
  type PlanningTurnAccepted,
  type SendPlanningMessageCommand,
  type FeaturePlans,
  type FeaturePlanVersion,
  type FactoryBoard,
  type FactoryGitHubIssues,
  type FactoryIssueImports,
  type FactoryIssuePublication,
  type ImportFactoryIssuesCommand,
  type SaveFeaturePlanCommand,
  type ChangeIntentVersionCreated,
  type CodexReviewModelPreference,
  type CodexSubscriptionConnection,
  type ConfigureDirectApiProfileCommand,
  type CreateChangeIntentVersionCommand,
  type DiagnosticAccepted,
  type DirectApiProfileResponse,
  type EventCursor,
  type InstallationEvent,
  type InstallationSnapshot,
  type HostGitHubConnection,
  type HostGitHubProjectInbox,
  type ObserveHostGitHubPullRequestCommand,
  type LoginCommand,
  type OpenLocalProjectCommand,
  type OpenPublicGitHubPullRequestCommand,
  type LocalRepositoryInventory,
  type LocalRepositoryReferences,
  type ProjectInbox,
  type ProjectUpserted,
  type RetainReviewRevisionCommand,
  type ReviewRevisionAvailable,
  type ReviewPreparation,
  type ReviewWorkflowAccepted,
  type Session,
  type SelectCodexReviewModelCommand,
  type StartReviewWorkflowCommand,
} from "@kestrel/contracts";

const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;
const STABLE_STREAM_MS = 10_000;
const CSRF_COOKIE_NAME = "__Host-kestrel-csrf";

interface Parser<T> {
  parse(value: unknown): T;
}

export type EventConnectionState = "connected" | "connecting" | "cursor-expired" | "reconnecting";

export interface StreamInstallationEventsOptions {
  after: EventCursor;
  onConnectionState?(state: EventConnectionState): void;
  onCursorExpired(
    error: Extract<ApiError, { code: "EVENT_CURSOR_EXPIRED" }>,
  ): EventCursor | Promise<EventCursor>;
  onEvent(event: InstallationEvent): void;
  signal: AbortSignal;
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly details: ApiError,
  ) {
    super(details.message);
    this.name = "ApiClientError";
  }
}

export class InvalidServerResponseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidServerResponseError";
  }
}

function parseServerValue<T>(parser: Parser<T>, value: unknown, description: string): T {
  try {
    return parser.parse(value);
  } catch (error) {
    throw new InvalidServerResponseError(`The server returned an invalid ${description}`, {
      cause: error,
    });
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new InvalidServerResponseError("The server returned invalid JSON", { cause: error });
  }
}

export async function requireJson<T>(
  response: Response,
  parser: Parser<T>,
  description: string,
): Promise<T> {
  const body = await readJson(response);
  if (!response.ok) {
    throw new ApiClientError(response.status, parseServerValue(ApiErrorSchema, body, "API error"));
  }
  return parseServerValue(parser, body, description);
}

function readCsrfToken(): string {
  const cookieHeader = typeof document === "undefined" ? "" : document.cookie;
  const prefix = `${CSRF_COOKIE_NAME}=`;
  const matches = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix));
  const token = matches.length === 1 ? matches[0]?.slice(prefix.length) : undefined;
  if (!token || !/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new Error("The authenticated mutation CSRF cookie is unavailable");
  }
  return token;
}

export function authenticatedMutationHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Kestrel-CSRF": readCsrfToken(),
    ...extra,
  };
}

async function requireNoContent(response: Response, description: string): Promise<void> {
  if (!response.ok) {
    const body = await readJson(response);
    throw new ApiClientError(response.status, parseServerValue(ApiErrorSchema, body, "API error"));
  }
  if (response.status !== 204 || (await response.arrayBuffer()).byteLength !== 0) {
    throw new InvalidServerResponseError(`The server returned an invalid ${description}`);
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fetchInstallation(signal?: AbortSignal): Promise<InstallationSnapshot> {
  const response = await fetch("/api/v1/installation", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    method: "GET",
    signal: signal ?? null,
  });
  return requireJson(response, InstallationSnapshotSchema, "Installation snapshot");
}

export async function fetchProjectInbox(signal?: AbortSignal): Promise<ProjectInbox> {
  const response = await fetch("/api/v1/projects", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    method: "GET",
    signal: signal ?? null,
  });
  return requireJson(response, ProjectInboxSchema, "Project inbox");
}

export function featurePath(projectId: string, featureId?: string): string {
  const path = `/api/v1/projects/${encodeURIComponent(KestrelIdSchema.parse(projectId))}/features`;
  return featureId === undefined
    ? path
    : `${path}/${encodeURIComponent(KestrelIdSchema.parse(featureId))}`;
}

export async function fetchFeatures(projectId: string, signal?: AbortSignal) {
  const response = await fetch(featurePath(projectId), {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal: signal ?? null,
  });
  return requireJson(response, FeatureListSchema, "feature list");
}

export async function fetchFactoryGitHubIssues(
  projectId: string,
  page = 1,
  signal?: AbortSignal,
): Promise<FactoryGitHubIssues> {
  const response = await fetch(
    `/api/v1/projects/${KestrelIdSchema.parse(projectId)}/github-issues?page=${String(FactoryGitHubIssuesSchema.shape.page.parse(page))}`,
    {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    },
  );
  return requireJson(response, FactoryGitHubIssuesSchema, "GitHub issues");
}

export async function fetchFactoryIssueImports(
  projectId: string,
  featureId: string,
  signal?: AbortSignal,
): Promise<FactoryIssueImports> {
  const response = await fetch(`${featurePath(projectId, featureId)}/imports`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal: signal ?? null,
  });
  return requireJson(response, FactoryIssueImportsSchema, "imported issues");
}

export async function importFactoryIssues(
  projectId: string,
  featureId: string,
  command: ImportFactoryIssuesCommand,
): Promise<FactoryIssueImports> {
  const response = await fetch(`${featurePath(projectId, featureId)}/imports`, {
    method: "POST",
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    body: JSON.stringify(ImportFactoryIssuesCommandSchema.parse(command)),
  });
  return requireJson(response, FactoryIssueImportsSchema, "imported issues");
}

export async function fetchFactoryIssuePublication(
  projectId: string,
  featureId: string,
  signal?: AbortSignal,
): Promise<FactoryIssuePublication> {
  const response = await fetch(`${featurePath(projectId, featureId)}/publication`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal: signal ?? null,
  });
  return requireJson(response, FactoryIssuePublicationSchema, "GitHub publication");
}

export async function retryFactoryIssuePublication(
  projectId: string,
  featureId: string,
  command: { requestId: string },
): Promise<FactoryIssuePublication> {
  const response = await fetch(`${featurePath(projectId, featureId)}/publication`, {
    method: "POST",
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    body: JSON.stringify(RetryFactoryPublicationCommandSchema.parse(command)),
  });
  return requireJson(response, FactoryIssuePublicationSchema, "GitHub publication request");
}

export async function fetchFeaturePlans(
  projectId: string,
  featureId: string,
  signal?: AbortSignal,
): Promise<FeaturePlans> {
  const response = await fetch(`${featurePath(projectId, featureId)}/plans`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal: signal ?? null,
  });
  return requireJson(response, FeaturePlansSchema, "feature plans");
}

function planVersionPath(projectId: string, featureId: string, version: number): string {
  return `${featurePath(projectId, featureId)}/plans/${String(FeaturePlanVersionSchema.shape.version.parse(version))}`;
}

export async function fetchFeaturePlanVersion(
  projectId: string,
  featureId: string,
  version: number,
  signal?: AbortSignal,
): Promise<FeaturePlanVersion> {
  const response = await fetch(planVersionPath(projectId, featureId, version), {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal: signal ?? null,
  });
  return requireJson(response, FeaturePlanVersionSchema, "feature plan version");
}

export async function saveFeaturePlan(
  projectId: string,
  featureId: string,
  command: SaveFeaturePlanCommand,
): Promise<FeaturePlanVersion> {
  const response = await fetch(`${featurePath(projectId, featureId)}/plans`, {
    method: "POST",
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    body: JSON.stringify(SaveFeaturePlanCommandSchema.parse(command)),
  });
  return requireJson(response, FeaturePlanVersionSchema, "saved feature plan");
}

type PlanVersionCommand = { requestId: string; expectedVersion: number | null };

export async function generateFeaturePlan(
  projectId: string,
  featureId: string,
  command: PlanVersionCommand,
): Promise<PlanningTurnAccepted> {
  const response = await fetch(`${featurePath(projectId, featureId)}/plans/generate`, {
    method: "POST",
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    body: JSON.stringify(GenerateFeaturePlanCommandSchema.parse(command)),
  });
  return requireJson(response, PlanningTurnAcceptedSchema, "accepted plan generation");
}

export async function approveFeaturePlan(
  projectId: string,
  featureId: string,
  version: number,
  command: { requestId: string },
): Promise<FactoryBoard> {
  const response = await fetch(`${planVersionPath(projectId, featureId, version)}/approve`, {
    method: "POST",
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    body: JSON.stringify(ApproveFeaturePlanCommandSchema.parse(command)),
  });
  return requireJson(response, FactoryBoardSchema, "approved feature board");
}

export async function fetchFactoryBoard(
  projectId: string,
  featureId: string,
  signal?: AbortSignal,
): Promise<FactoryBoard> {
  const response = await fetch(`${featurePath(projectId, featureId)}/board`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal: signal ?? null,
  });
  return requireJson(response, FactoryBoardSchema, "factory board");
}

export async function cancelFeature(
  projectId: string,
  featureId: string,
  command: PlanVersionCommand,
): Promise<FactoryBoard> {
  const response = await fetch(`${featurePath(projectId, featureId)}/cancel`, {
    method: "POST",
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    body: JSON.stringify(CancelFeatureCommandSchema.parse(command)),
  });
  return requireJson(response, FactoryBoardSchema, "cancelled feature board");
}

export async function createFeature(
  projectId: string,
  command: CreateFeatureCommand,
): Promise<Feature> {
  const response = await fetch(featurePath(projectId), {
    method: "POST",
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    body: JSON.stringify(CreateFeatureCommandSchema.parse(command)),
  });
  return requireJson(response, FeatureSchema, "feature");
}

export async function fetchFeatureChat(
  projectId: string,
  featureId: string,
  signal?: AbortSignal,
): Promise<FeatureChat> {
  const response = await fetch(featurePath(projectId, featureId), {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal: signal ?? null,
  });
  return requireJson(response, FeatureChatSchema, "feature chat");
}

export async function sendPlanningMessage(
  projectId: string,
  featureId: string,
  command: SendPlanningMessageCommand,
): Promise<PlanningTurnAccepted> {
  const response = await fetch(`${featurePath(projectId, featureId)}/messages`, {
    method: "POST",
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    body: JSON.stringify(SendPlanningMessageCommandSchema.parse(command)),
  });
  return requireJson(response, PlanningTurnAcceptedSchema, "accepted planning turn");
}

export async function retryPlanningTurn(
  projectId: string,
  featureId: string,
  turnId: string,
  command: { requestId: string },
): Promise<PlanningTurnAccepted> {
  const response = await fetch(
    `${featurePath(projectId, featureId)}/turns/${encodeURIComponent(KestrelIdSchema.parse(turnId))}/retry`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: authenticatedMutationHeaders(),
      body: JSON.stringify(RetryPlanningTurnCommandSchema.parse(command)),
    },
  );
  return requireJson(response, PlanningTurnAcceptedSchema, "accepted planning retry");
}

export async function cancelPlanningTurn(
  projectId: string,
  featureId: string,
  turnId: string,
): Promise<FeatureChat> {
  const response = await fetch(
    `${featurePath(projectId, featureId)}/turns/${encodeURIComponent(KestrelIdSchema.parse(turnId))}/cancel`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: authenticatedMutationHeaders(),
      body: JSON.stringify({}),
    },
  );
  return requireJson(response, FeatureChatSchema, "stopped planning turn");
}

export async function fetchHostGitHubConnection(
  projectId?: string,
  signal?: AbortSignal,
): Promise<HostGitHubConnection> {
  const query =
    projectId === undefined
      ? ""
      : `?projectId=${encodeURIComponent(KestrelIdSchema.parse(projectId))}`;
  const response = await fetch(`/api/v1/connections/github${query}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    method: "GET",
    signal: signal ?? null,
  });
  return requireJson(response, HostGitHubConnectionSchema, "host GitHub Connection");
}

export async function fetchCodexSubscriptionConnection(
  signal?: AbortSignal,
): Promise<CodexSubscriptionConnection> {
  const response = await fetch("/api/v1/connections/codex", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    method: "GET",
    signal: signal ?? null,
  });
  return requireJson(response, CodexSubscriptionConnectionSchema, "Codex subscription Connection");
}

export async function fetchCodexReviewModelPreference(
  signal?: AbortSignal,
): Promise<CodexReviewModelPreference> {
  const response = await fetch("/api/v1/settings/review-model", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    method: "GET",
    signal: signal ?? null,
  });
  return requireJson(response, CodexReviewModelPreferenceSchema, "Codex review model preference");
}

export async function selectCodexReviewModel(
  command: SelectCodexReviewModelCommand,
  signal?: AbortSignal,
): Promise<CodexReviewModelPreference> {
  const validated = SelectCodexReviewModelCommandSchema.parse(command);
  const response = await fetch("/api/v1/settings/review-model", {
    body: JSON.stringify(validated),
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    method: "PUT",
    signal: signal ?? null,
  });
  return requireJson(response, CodexReviewModelPreferenceSchema, "Codex review model preference");
}

export async function fetchReviewPreparation(
  projectId: string,
  changeProposalId: string,
  signal?: AbortSignal,
): Promise<ReviewPreparation> {
  const validatedProjectId = KestrelIdSchema.parse(projectId);
  const validatedProposalId = KestrelIdSchema.parse(changeProposalId);
  const response = await fetch(
    `/api/v1/projects/${encodeURIComponent(validatedProjectId)}/change-proposals/${encodeURIComponent(validatedProposalId)}/review-preparation`,
    {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      method: "GET",
      signal: signal ?? null,
    },
  );
  return requireJson(response, ReviewPreparationSchema, "Review preparation");
}

export async function startReviewWorkflow(
  projectId: string,
  changeProposalId: string,
  command: StartReviewWorkflowCommand,
  signal?: AbortSignal,
): Promise<ReviewWorkflowAccepted> {
  const validatedProjectId = KestrelIdSchema.parse(projectId);
  const validatedProposalId = KestrelIdSchema.parse(changeProposalId);
  const validatedCommand = StartReviewWorkflowCommandSchema.parse(command);
  const response = await fetch(
    `/api/v1/projects/${encodeURIComponent(validatedProjectId)}/change-proposals/${encodeURIComponent(validatedProposalId)}/review-workflows`,
    {
      body: JSON.stringify(validatedCommand),
      credentials: "same-origin",
      headers: authenticatedMutationHeaders(),
      method: "POST",
      signal: signal ?? null,
    },
  );
  return requireJson(response, ReviewWorkflowAcceptedSchema, "Review Workflow response");
}

export async function createChangeIntentVersion(
  projectId: string,
  changeProposalId: string,
  command: CreateChangeIntentVersionCommand,
  signal?: AbortSignal,
): Promise<ChangeIntentVersionCreated> {
  const idSchema = ProjectInboxSchema.shape.projects.element.shape.id;
  const validatedProjectId = idSchema.parse(projectId);
  const validatedProposalId = idSchema.parse(changeProposalId);
  const validatedCommand = CreateChangeIntentVersionCommandSchema.parse(command);
  const response = await fetch(
    `/api/v1/projects/${encodeURIComponent(validatedProjectId)}/change-proposals/${encodeURIComponent(validatedProposalId)}/change-intents`,
    {
      body: JSON.stringify(validatedCommand),
      credentials: "same-origin",
      headers: authenticatedMutationHeaders(),
      method: "POST",
      signal: signal ?? null,
    },
  );
  return requireJson(response, ChangeIntentVersionCreatedSchema, "Change Intent version response");
}

export async function fetchHostGitHubProjectInbox(
  projectId: string,
  refresh = false,
  signal?: AbortSignal,
): Promise<HostGitHubProjectInbox> {
  const validatedId = ProjectInboxSchema.shape.projects.element.shape.id.parse(projectId);
  const response = await fetch(
    `/api/v1/projects/${encodeURIComponent(validatedId)}/provider/github${refresh ? "?refresh=true" : ""}`,
    {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      method: "GET",
      signal: signal ?? null,
    },
  );
  const inbox = await requireJson(
    response,
    HostGitHubProjectInboxSchema,
    "host GitHub Project inbox",
  );
  if (inbox.projectId !== validatedId) {
    throw new InvalidServerResponseError(
      "The server returned an invalid host GitHub Project inbox",
    );
  }
  return inbox;
}

export async function observeHostGitHubPullRequest(
  projectId: string,
  command: ObserveHostGitHubPullRequestCommand,
  signal?: AbortSignal,
): Promise<ProjectUpserted> {
  const validatedId = ProjectInboxSchema.shape.projects.element.shape.id.parse(projectId);
  const validated = ObserveHostGitHubPullRequestCommandSchema.parse(command);
  const response = await fetch(
    `/api/v1/projects/${encodeURIComponent(validatedId)}/provider/github/pull-requests/observe`,
    {
      body: JSON.stringify(validated),
      credentials: "same-origin",
      headers: authenticatedMutationHeaders(),
      method: "POST",
      signal: signal ?? null,
    },
  );
  return requireJson(response, ProjectUpsertedSchema, "observed Project response");
}

export async function fetchLocalRepositories(
  signal?: AbortSignal,
): Promise<LocalRepositoryInventory> {
  const response = await fetch("/api/v1/local-repository-sources", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    method: "GET",
    signal: signal ?? null,
  });
  return requireJson(response, LocalRepositoryInventorySchema, "local repository inventory");
}

export async function fetchLocalRepositoryReferences(
  repositoryId: string,
  signal?: AbortSignal,
): Promise<LocalRepositoryReferences> {
  const validatedId = KestrelIdSchema.parse(repositoryId);
  const response = await fetch(
    `/api/v1/local-repository-sources/${encodeURIComponent(validatedId)}/references`,
    {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      method: "GET",
      signal: signal ?? null,
    },
  );
  return requireJson(response, LocalRepositoryReferencesSchema, "local repository references");
}

export async function retainReviewRevision(
  command: RetainReviewRevisionCommand,
  signal?: AbortSignal,
): Promise<ReviewRevisionAvailable> {
  const validated = RetainReviewRevisionCommandSchema.parse(command);
  const response = await fetch("/api/v1/review-revisions", {
    body: JSON.stringify(validated),
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    method: "POST",
    signal: signal ?? null,
  });
  return requireJson(response, ReviewRevisionAvailableSchema, "Review Revision response");
}

export async function openPublicGitHubPullRequest(
  command: OpenPublicGitHubPullRequestCommand,
  signal?: AbortSignal,
): Promise<ProjectUpserted> {
  const validated = OpenPublicGitHubPullRequestCommandSchema.parse(command);
  const response = await fetch("/api/v1/projects", {
    body: JSON.stringify(validated),
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    method: "POST",
    signal: signal ?? null,
  });
  return requireJson(response, ProjectUpsertedSchema, "Project response");
}

export async function openLocalProject(
  command: OpenLocalProjectCommand,
  signal?: AbortSignal,
): Promise<ProjectUpserted> {
  const validated = OpenLocalProjectCommandSchema.parse(command);
  const response = await fetch("/api/v1/projects/local", {
    body: JSON.stringify(validated),
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    method: "POST",
    signal: signal ?? null,
  });
  return requireJson(response, ProjectUpsertedSchema, "local Project response");
}

function directApiProfileUrl(projectId: string): string {
  return `/api/v1/projects/${encodeURIComponent(KestrelIdSchema.parse(projectId))}/model-profiles/direct-api`;
}

export async function fetchDirectApiProfile(
  projectId: string,
  signal?: AbortSignal,
): Promise<DirectApiProfileResponse> {
  const response = await fetch(directApiProfileUrl(projectId), {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    method: "GET",
    signal: signal ?? null,
  });
  return requireJson(response, DirectApiProfileResponseSchema, "Direct API profile");
}

export async function configureDirectApiProfile(
  projectId: string,
  command: ConfigureDirectApiProfileCommand,
  currentPassword: string,
  signal?: AbortSignal,
): Promise<DirectApiProfileResponse> {
  const validatedProjectId = KestrelIdSchema.parse(projectId);
  const validatedCommand = ConfigureDirectApiProfileCommandSchema.parse(command);
  const serializedCommand = serializeConfigureDirectApiProfileCommand(validatedCommand);
  const stepUp = StepUpCommandSchema.parse({
    action: "model_credentials_change",
    password: currentPassword,
    requestDigest: await sha256(serializedCommand),
    targetId: validatedProjectId,
  });
  const stepUpResponse = await fetch("/auth/step-up", {
    body: JSON.stringify(stepUp),
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    method: "POST",
    signal: signal ?? null,
  });
  const proof = await requireJson(stepUpResponse, StepUpProofSchema, "step-up proof");
  const response = await fetch(directApiProfileUrl(validatedProjectId), {
    body: serializedCommand,
    credentials: "same-origin",
    headers: authenticatedMutationHeaders({ "X-Kestrel-Step-Up": proof.proof }),
    method: "POST",
    signal: signal ?? null,
  });
  return requireJson(response, DirectApiProfileResponseSchema, "Direct API profile");
}

export async function testDirectApiProfile(
  projectId: string,
  signal?: AbortSignal,
): Promise<DirectApiProfileResponse> {
  const response = await fetch(`${directApiProfileUrl(projectId)}/test`, {
    body: "{}",
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    method: "POST",
    signal: signal ?? null,
  });
  return requireJson(response, DirectApiProfileResponseSchema, "Direct API profile");
}

export async function fetchSession(signal?: AbortSignal): Promise<Session> {
  const response = await fetch("/api/v1/session", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    method: "GET",
    signal: signal ?? null,
  });
  return requireJson(response, SessionSchema, "Operator session");
}

export async function loginOperator(command: LoginCommand, signal?: AbortSignal): Promise<Session> {
  const validated = LoginCommandSchema.parse(command);
  const response = await fetch("/auth/login", {
    body: JSON.stringify(validated),
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: signal ?? null,
  });
  return requireJson(response, SessionSchema, "Operator session");
}

export interface LogoutOutcome {
  auditError: ApiError | null;
}

export async function logoutOperator(signal?: AbortSignal): Promise<LogoutOutcome> {
  const response = await fetch("/auth/logout", {
    body: "{}",
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    method: "POST",
    signal: signal ?? null,
  });
  if (response.status === 503) {
    return {
      auditError: parseServerValue(ApiErrorSchema, await readJson(response), "API error"),
    };
  }
  await requireNoContent(response, "logout response");
  return { auditError: null };
}

export interface UpdateOperatorCredentialsInput {
  currentPassword: string;
  newPassword: string;
  session: Session;
  username: string;
}

export async function updateOperatorCredentials(
  input: UpdateOperatorCredentialsInput,
  signal?: AbortSignal,
): Promise<void> {
  const command = CredentialChangeCommandSchema.parse({
    expectedVersion: input.session.credentialVersion,
    newPassword: input.newPassword,
    username: input.username,
  });
  const stepUp = StepUpCommandSchema.parse({
    action: "operator_credentials_change",
    password: input.currentPassword,
    requestDigest: await sha256(serializeCredentialChangeCommand(command)),
    targetId: input.session.operator.id,
  });
  const stepUpResponse = await fetch("/auth/step-up", {
    body: JSON.stringify(stepUp),
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    method: "POST",
    signal: signal ?? null,
  });
  const proof = await requireJson(stepUpResponse, StepUpProofSchema, "step-up proof");
  const changeResponse = await fetch("/api/v1/operator/credentials", {
    body: serializeCredentialChangeCommand(command),
    credentials: "same-origin",
    headers: authenticatedMutationHeaders({ "X-Kestrel-Step-Up": proof.proof }),
    method: "POST",
    signal: signal ?? null,
  });
  await requireNoContent(changeResponse, "credential-change response");
}

export async function runDiagnostic(signal?: AbortSignal): Promise<DiagnosticAccepted> {
  const response = await fetch("/api/v1/installation/diagnostics", {
    body: "{}",
    credentials: "same-origin",
    headers: authenticatedMutationHeaders(),
    method: "POST",
    signal: signal ?? null,
  });
  return requireJson(response, DiagnosticAcceptedSchema, "diagnostic response");
}

function parseEventData(value: string, description: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new InvalidServerResponseError(`The server returned invalid ${description} JSON`, {
      cause: error,
    });
  }
}

function parseCursorExpired(value: unknown) {
  const error = parseServerValue(ApiErrorSchema, value, "cursor-expiry error");
  if (error.code !== "EVENT_CURSOR_EXPIRED") {
    throw new InvalidServerResponseError("The server returned the wrong cursor-expiry error");
  }
  return error;
}

type StreamReadResult =
  | { kind: "aborted" }
  | { error: Extract<ApiError, { code: "EVENT_CURSOR_EXPIRED" }>; kind: "cursor-expired" }
  | { kind: "ended" };

async function readEventStream(
  response: Response,
  cursor: EventCursor,
  options: StreamInstallationEventsOptions,
): Promise<{ cursor: EventCursor; result: StreamReadResult }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("text/event-stream")) {
    throw new InvalidServerResponseError("The server did not return an event stream");
  }
  if (response.body === null) {
    throw new InvalidServerResponseError("The event stream has no response body");
  }

  let confirmedCursor = cursor;
  let cursorExpired: Extract<ApiError, { code: "EVENT_CURSOR_EXPIRED" }> | undefined;
  const parser = createParser({
    maxBufferSize: 64 * 1_024,
    onEvent(message) {
      const body = parseEventData(message.data, "event");
      if (message.event === "reset-required") {
        cursorExpired = parseCursorExpired(body);
        return;
      }

      const event = parseServerValue(InstallationEventSchema, body, "Installation event");
      if (message.id !== event.eventId || message.event !== event.eventType) {
        throw new InvalidServerResponseError("The SSE fields do not match the event envelope");
      }
      if (BigInt(event.eventId) <= BigInt(confirmedCursor)) {
        throw new InvalidServerResponseError("The event stream did not advance its cursor");
      }
      confirmedCursor = event.eventId;
      options.onEvent(event);
    },
  });
  const decoder = new TextDecoder();
  const reader = response.body.getReader();

  try {
    while (!options.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        return { cursor: confirmedCursor, result: { kind: "ended" } };
      }
      parser.feed(decoder.decode(chunk.value, { stream: true }));
      if (cursorExpired) {
        return {
          cursor: confirmedCursor,
          result: { error: cursorExpired, kind: "cursor-expired" },
        };
      }
    }
    return { cursor: confirmedCursor, result: { kind: "aborted" } };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function waitForReconnect(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function isFatalStreamError(error: unknown): boolean {
  return (
    error instanceof InvalidServerResponseError ||
    (error instanceof ApiClientError && error.status < 500)
  );
}

function isSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export async function streamInstallationEvents(
  options: StreamInstallationEventsOptions,
): Promise<void> {
  let cursor = parseServerValue(EventCursorSchema, options.after, "event cursor");
  let reconnectAttempt = 0;
  options.onConnectionState?.("connecting");

  while (!options.signal.aborted) {
    try {
      const response = await fetch("/api/v1/events", {
        credentials: "same-origin",
        headers: {
          Accept: "text/event-stream",
          "Last-Event-ID": cursor,
        },
        method: "GET",
        signal: options.signal,
      });

      if (response.status === 409) {
        const error = parseCursorExpired(await readJson(response));
        options.onConnectionState?.("cursor-expired");
        cursor = parseServerValue(
          EventCursorSchema,
          await options.onCursorExpired(error),
          "event cursor",
        );
        reconnectAttempt = 0;
        options.onConnectionState?.("connecting");
        continue;
      }
      if (!response.ok) {
        await requireJson(response, InstallationEventSchema, "Installation event");
      }

      options.onConnectionState?.("connected");
      const connectedAt = Date.now();
      const cursorAtConnection = cursor;
      const stream = await readEventStream(response, cursor, options);
      cursor = stream.cursor;
      if (stream.result.kind === "aborted" || isSignalAborted(options.signal)) {
        return;
      }
      if (stream.result.kind === "cursor-expired") {
        reconnectAttempt = 0;
        options.onConnectionState?.("cursor-expired");
        cursor = parseServerValue(
          EventCursorSchema,
          await options.onCursorExpired(stream.result.error),
          "event cursor",
        );
        options.onConnectionState?.("connecting");
        continue;
      }
      if (cursor !== cursorAtConnection || Date.now() - connectedAt >= STABLE_STREAM_MS) {
        reconnectAttempt = 0;
      }
      throw new Error("The event stream disconnected");
    } catch (error) {
      if (isSignalAborted(options.signal)) {
        return;
      }
      if (isFatalStreamError(error)) {
        throw error;
      }

      options.onConnectionState?.("reconnecting");
      const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
      await waitForReconnect(delay ?? RECONNECT_DELAYS_MS.at(-1) ?? 5_000, options.signal);
      reconnectAttempt += 1;
    }
  }
}
