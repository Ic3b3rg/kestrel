import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";

import { z } from "zod";
import { CodexAppServerTransport, CodexFactoryError } from "./codex-app-server-transport.js";

import {
  CodexChatGptPlanSchema,
  CodexSubscriptionConnectionSchema,
  type CodexSubscriptionConnection,
  type CodexSubscriptionConnectionReason,
  type CodexSubscriptionUsage,
} from "@kestrel/contracts";

const CLIENT_NAME = "kestrel";
const CLIENT_VERSION = "0.0.0";
const DEFAULT_ARGUMENTS = ["app-server", "--stdio"] as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const MODEL_PAGE_SIZE = 100;
const MAX_MODEL_PAGES = 5;
const MINIMUM_CODEX_MINOR_VERSION = 152;

const InitializeResultSchema = z.strictObject({
  codexHome: z.string().min(1),
  platformFamily: z.literal("unix"),
  platformOs: z.literal("macos"),
  userAgent: z.string().min(1).max(512),
});
const AccountResultSchema = z.strictObject({
  account: z
    .union([
      z.strictObject({
        type: z.literal("chatgpt"),
        email: z.email().max(320).nullable(),
        planType: CodexChatGptPlanSchema,
      }),
      z.strictObject({ type: z.literal("apiKey") }),
      z.strictObject({
        type: z.literal("amazonBedrock"),
        usesCodexManagedCredentials: z.boolean().optional(),
      }),
    ])
    .nullable(),
  requiresOpenaiAuth: z.boolean(),
  workspaceRouting: z
    .strictObject({
      chatgptAccountId: z.string().max(512),
      backendOrigin: z.string().max(2_048),
      accountRoutingOverride: z.enum(["NO_CONSTRAINT", "us", "us_cr"]),
    })
    .nullable()
    .optional(),
});
const BoundedProtocolStringSchema = z.string().max(10_000);
const ModelServiceTierSchema = z.strictObject({
  description: BoundedProtocolStringSchema,
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
});
const ModelUpgradeInfoSchema = z.strictObject({
  migrationMarkdown: BoundedProtocolStringSchema.nullable().optional(),
  model: z.string().min(1).max(128),
  modelLink: z.string().max(2_048).nullable().optional(),
  retirementAt: z.number().int().nonnegative().nullable().optional(),
  upgradeCopy: BoundedProtocolStringSchema.nullable().optional(),
});
const ModelSchema = z.strictObject({
  additionalSpeedTiers: z.array(z.string().max(128)).max(20).optional(),
  availabilityNux: z.strictObject({ message: BoundedProtocolStringSchema }).nullable().optional(),
  availableAccessPrograms: z
    .strictObject({ cyber: z.array(z.enum(["standard", "daybreakBlue", "daybreakRed"])).max(3) })
    .nullable()
    .optional(),
  defaultReasoningEffort: z.string().min(1).max(128),
  defaultServiceTier: z.string().min(1).max(128).nullable().optional(),
  description: BoundedProtocolStringSchema,
  displayName: z.string().min(1).max(128),
  hidden: z.literal(false),
  id: z.string().min(1).max(128),
  inputModalities: z
    .array(z.enum(["text", "image", "audio"]))
    .max(3)
    .optional(),
  isDefault: z.boolean(),
  model: z.string().min(1).max(128),
  modelSpecialty: z.string().max(128).nullable().optional(),
  multiAgentVersion: z.enum(["disabled", "v1", "v2"]).nullable().optional(),
  serviceTiers: z.array(ModelServiceTierSchema).max(20).optional(),
  supportedReasoningEfforts: z
    .array(
      z.strictObject({
        description: BoundedProtocolStringSchema,
        reasoningEffort: z.string().min(1).max(128),
      }),
    )
    .max(20),
  supportsPersonality: z.boolean().optional(),
  upgrade: z.string().max(128).nullable().optional(),
  upgradeInfo: ModelUpgradeInfoSchema.nullable().optional(),
});
const ModelListResultSchema = z.strictObject({
  data: z.array(ModelSchema).max(MODEL_PAGE_SIZE),
  nextCursor: z.string().min(1).max(512).nullable().optional(),
});
type AppServerModel = z.infer<typeof ModelSchema>;
type ModelListResult = z.infer<typeof ModelListResultSchema>;
const RateLimitWindowSchema = z.strictObject({
  usedPercent: z.number().int().min(0).max(100),
  windowDurationMins: z.number().int().positive().max(525_600).nullable().optional(),
  resetsAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
});
const RateLimitsResultSchema = z.strictObject({
  ordinaryUsageAllowed: z.boolean().optional(),
  accountId: z.unknown().optional(),
  rateLimitResetCredits: z.unknown().optional(),
  rateLimitUpsell: z.unknown().optional(),
  rateLimits: z.strictObject({
    credits: z.unknown().optional(),
    individualLimit: z.unknown().optional(),
    limitId: z.unknown().optional(),
    limitName: z.unknown().optional(),
    normalModelSlug: z.string().min(1).max(128).nullable().optional(),
    planType: CodexChatGptPlanSchema.nullable().optional(),
    primary: RateLimitWindowSchema.nullable().optional(),
    secondary: RateLimitWindowSchema.nullable().optional(),
    rateLimitReachedType: z
      .enum([
        "rate_limit_reached",
        "workspace_owner_credits_depleted",
        "workspace_member_credits_depleted",
        "workspace_owner_usage_limit_reached",
        "workspace_member_usage_limit_reached",
      ])
      .nullable()
      .optional(),
    spendControlReached: z.boolean().nullable().optional(),
  }),
  rateLimitsByLimitId: z.unknown().optional(),
});

type CodexAppServerErrorKind =
  | "cancelled"
  | "crashed"
  | "invalid_response"
  | "timeout"
  | "unavailable"
  | "unsupported_protocol"
  | "unsupported_version";
type IncompleteProbeReason = Exclude<
  CodexSubscriptionConnectionReason,
  "usage_limit_reached" | "waiting_for_usage_reset"
>;

export class CodexAppServerError extends Error {
  constructor(public readonly kind: CodexAppServerErrorKind) {
    super(`Codex App Server probe failed: ${kind}`);
    this.name = "CodexAppServerError";
  }
}

interface CodexAppServerOptions {
  executable?: string;
  arguments?: readonly string[];
  timeoutMs?: number;
}

export interface CodexAgentRuntimePort {
  readConnection(signal?: AbortSignal): Promise<CodexSubscriptionConnection>;
}

async function probeRequest<T>(
  session: CodexAppServerTransport,
  method: string,
  params: unknown,
  schema: z.ZodType<T>,
  invalidResponseKind: "invalid_response" | "unsupported_protocol" = "invalid_response",
): Promise<T> {
  const response = await session.request(
    method,
    params,
    () => new CodexAppServerError(invalidResponseKind),
  );
  const parsed = schema.safeParse(response);
  if (!parsed.success) throw new CodexAppServerError(invalidResponseKind);
  return parsed.data;
}

function readCodexVersion(userAgent: string): { supported: boolean; version: string } {
  const match = /^kestrel\/(\d+)\.(\d+)\.([0-9A-Za-z.+-]+)(?:\s|$)/u.exec(userAgent);
  const major = match?.[1];
  const minor = match?.[2];
  const patch = match?.[3];
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new CodexAppServerError("unsupported_protocol");
  }
  const supported = Number(major) > 0 || Number(minor) >= MINIMUM_CODEX_MINOR_VERSION;
  return { supported, version: `${major}.${minor}.${patch}` };
}

async function readAvailableModels(session: CodexAppServerTransport): Promise<AppServerModel[]> {
  const models: AppServerModel[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const result: ModelListResult = await probeRequest(
      session,
      "model/list",
      { cursor, includeHidden: false, limit: MODEL_PAGE_SIZE },
      ModelListResultSchema,
    );
    models.push(...result.data);

    const nextCursor: string | null = result.nextCursor ?? null;
    if (nextCursor === null) {
      if (new Set(models.map(({ id }) => id)).size !== models.length) {
        throw new CodexAppServerError("invalid_response");
      }
      return models;
    }
    if (result.data.length === 0) throw new CodexAppServerError("invalid_response");
    if (seenCursors.has(nextCursor)) throw new CodexAppServerError("invalid_response");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new CodexAppServerError("invalid_response");
}

function mapWindow(window: z.infer<typeof RateLimitWindowSchema> | null | undefined) {
  if (window == null) return null;
  const resetsAt = window.resetsAt;
  return {
    usedPercent: window.usedPercent,
    windowDurationMinutes: window.windowDurationMins ?? null,
    resetsAt: resetsAt == null ? null : new Date(resetsAt * 1_000).toISOString(),
  };
}

function normalizeUsage(
  rateLimits: z.infer<typeof RateLimitsResultSchema>["rateLimits"],
): CodexSubscriptionUsage {
  const primary = mapWindow(rateLimits.primary);
  const secondary = mapWindow(rateLimits.secondary);
  const reachedType = rateLimits.rateLimitReachedType;
  const actionRequired =
    rateLimits.spendControlReached === true ||
    reachedType === "workspace_owner_credits_depleted" ||
    reachedType === "workspace_member_credits_depleted" ||
    reachedType === "workspace_owner_usage_limit_reached" ||
    reachedType === "workspace_member_usage_limit_reached";
  const waiting =
    reachedType === "rate_limit_reached" ||
    primary?.usedPercent === 100 ||
    secondary?.usedPercent === 100;
  return {
    availability: actionRequired
      ? "usage_limit_reached_action_required"
      : waiting
        ? "waiting_for_usage_reset"
        : "available",
    primary,
    secondary,
  };
}

function failedConnection(
  reason: IncompleteProbeReason,
  cli: CodexSubscriptionConnection["cli"] = null,
): CodexSubscriptionConnection {
  const state =
    reason === "timed_out" || reason === "unexpected_response" ? "unavailable" : "action_required";
  return CodexSubscriptionConnectionSchema.parse({
    schemaVersion: 1,
    state,
    reason,
    cli,
    account: null,
    models: [],
    usage: null,
    checkedAt: new Date().toISOString(),
  });
}

function failureReason(error: unknown): IncompleteProbeReason {
  if (error instanceof CodexFactoryError) {
    if (error.code === "cancelled") throw new CodexAppServerError("cancelled");
    if (error.code === "timeout") return "timed_out";
    if (error.code === "unavailable") return "cli_not_installed";
    return "unexpected_response";
  }
  if (!(error instanceof CodexAppServerError)) return "unexpected_response";
  switch (error.kind) {
    case "unavailable":
      return "cli_not_installed";
    case "unsupported_version":
      return "cli_version_unsupported";
    case "unsupported_protocol":
      return "protocol_unsupported";
    case "timeout":
      return "timed_out";
    case "crashed":
    case "invalid_response":
      return "unexpected_response";
    case "cancelled":
      throw error;
  }
}

export function createCodexAppServerAgentRuntime(
  options: CodexAppServerOptions = {},
): CodexAgentRuntimePort {
  const executable = options.executable ?? process.env.KESTREL_CODEX_EXECUTABLE;
  const args = options.arguments ?? DEFAULT_ARGUMENTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async readConnection(signal) {
      if (signal?.aborted) throw new CodexAppServerError("cancelled");
      if (executable === undefined || !isAbsolute(executable)) {
        return failedConnection("cli_not_installed");
      }
      const session = new CodexAppServerTransport({
        profile: "connection",
        executable,
        arguments: args,
        timeoutMs,
        cwd: tmpdir(),
        ...(signal === undefined ? {} : { signal }),
        receive(message) {
          // Inspection has no authority to service approval or tool requests.
          if ("id" in message || typeof message.method !== "string")
            throw new CodexAppServerError("invalid_response");
        },
      });
      let cli: CodexSubscriptionConnection["cli"] = null;
      try {
        const initialized = await probeRequest(
          session,
          "initialize",
          {
            clientInfo: { name: CLIENT_NAME, title: "Kestrel", version: CLIENT_VERSION },
          },
          InitializeResultSchema,
          "unsupported_protocol",
        );
        const version = readCodexVersion(initialized.userAgent);
        cli = { ...version, protocol: "app_server_v2" };
        if (!version.supported) throw new CodexAppServerError("unsupported_version");
        session.notify("initialized", {});

        const accountResult = await probeRequest(
          session,
          "account/read",
          { refreshToken: false },
          AccountResultSchema,
        );
        if (accountResult.account === null) {
          return failedConnection(
            accountResult.requiresOpenaiAuth
              ? "authentication_required"
              : "chatgpt_subscription_required",
            cli,
          );
        }
        if (accountResult.account.type !== "chatgpt") {
          return failedConnection("chatgpt_subscription_required", cli);
        }

        const models = await readAvailableModels(session);
        const rateLimits = await probeRequest(
          session,
          "account/rateLimits/read",
          null,
          RateLimitsResultSchema,
        );
        if (
          rateLimits.rateLimits.planType != null &&
          rateLimits.rateLimits.planType !== accountResult.account.planType
        ) {
          throw new CodexAppServerError("invalid_response");
        }
        const usage = normalizeUsage(rateLimits.rateLimits);
        const reason =
          models.length === 0
            ? ("model_catalog_empty" as const)
            : usage.availability === "waiting_for_usage_reset"
              ? ("waiting_for_usage_reset" as const)
              : usage.availability === "usage_limit_reached_action_required"
                ? ("usage_limit_reached" as const)
                : null;
        return CodexSubscriptionConnectionSchema.parse({
          schemaVersion: 1,
          state:
            reason === null
              ? "ready"
              : reason === "waiting_for_usage_reset"
                ? "waiting_for_usage_reset"
                : "action_required",
          reason,
          cli,
          account: {
            authentication: "chatgpt",
            email: accountResult.account.email,
            plan: accountResult.account.planType,
          },
          models: models.map(
            ({
              id,
              displayName,
              isDefault,
              model,
              inputModalities,
              defaultReasoningEffort,
              supportedReasoningEfforts,
              serviceTiers,
              defaultServiceTier,
            }) => ({
              id,
              displayName,
              isDefault,
              model,
              defaultReasoningEffort,
              supportedReasoningEfforts,
              ...(inputModalities === undefined ? {} : { inputModalities }),
              ...(serviceTiers === undefined ? {} : { serviceTiers }),
              ...(defaultServiceTier === undefined ? {} : { defaultServiceTier }),
            }),
          ),
          usage,
          checkedAt: new Date().toISOString(),
        });
      } catch (error) {
        return failedConnection(failureReason(error), cli);
      } finally {
        await session.close();
      }
    },
  };
}
