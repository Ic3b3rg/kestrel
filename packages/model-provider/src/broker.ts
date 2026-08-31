import type {
  DirectApiLimits,
  DirectApiModelTarget,
  DirectApiSyntheticTest,
} from "@kestrel/contracts";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses" as const;
export const OPENAI_API_VERSION = "2020-10-01" as const;

export type DirectApiBrokerErrorCode =
  | "credential_unavailable"
  | "destination_rejected"
  | "identity_drift"
  | "provider_unavailable"
  | "synthetic_test_failed";

export class DirectApiBrokerError extends Error {
  public constructor(
    public readonly code: DirectApiBrokerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DirectApiBrokerError";
  }
}

export interface OpenAiSyntheticRequestBody {
  readonly input: "Return the Kestrel synthetic profile-test marker.";
  readonly instructions: "This is a Kestrel connectivity test. Return only the required synthetic JSON object.";
  readonly max_output_tokens: number;
  readonly model: string;
  readonly store: false;
  readonly text: {
    readonly format: {
      readonly name: "kestrel_profile_test";
      readonly schema: {
        readonly additionalProperties: false;
        readonly properties: {
          readonly kestrelSynthetic: { readonly const: "ok"; readonly type: "string" };
        };
        readonly required: readonly ["kestrelSynthetic"];
        readonly type: "object";
      };
      readonly strict: true;
      readonly type: "json_schema";
    };
  };
}

export interface OpenAiTransportRequest {
  readonly body: OpenAiSyntheticRequestBody;
  readonly headers: {
    readonly Authorization: string;
    readonly "OpenAI-Organization": string;
    readonly "OpenAI-Project": string;
  };
  readonly method: "POST";
  readonly redirectPolicy: "reject";
  readonly timeoutMilliseconds: number;
  readonly tls: {
    readonly minimumVersion: "TLSv1.2";
    readonly rejectUnauthorized: true;
    readonly serverName: "api.openai.com";
  };
  readonly url: typeof OPENAI_RESPONSES_URL;
}

export interface OpenAiTransportResponse {
  readonly body: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly statusCode: number;
}

export interface OpenAiTransport {
  send(request: OpenAiTransportRequest): Promise<OpenAiTransportResponse>;
}

export interface DirectApiCertificationInput {
  readonly apiKey: string;
  readonly limits: DirectApiLimits;
  readonly model: DirectApiModelTarget;
  readonly openAiProjectId: string;
  readonly organizationId: string;
}

const syntheticSchema = {
  additionalProperties: false,
  properties: { kestrelSynthetic: { const: "ok", type: "string" } },
  required: ["kestrelSynthetic"],
  type: "object",
} as const;

function buildRequest(input: DirectApiCertificationInput): OpenAiTransportRequest {
  const body: OpenAiSyntheticRequestBody = {
    input: "Return the Kestrel synthetic profile-test marker.",
    instructions:
      "This is a Kestrel connectivity test. Return only the required synthetic JSON object.",
    max_output_tokens: Math.min(32, input.limits.maximumOutputTokens),
    model: input.model.requestedId,
    store: false,
    text: {
      format: {
        name: "kestrel_profile_test",
        schema: syntheticSchema,
        strict: true,
        type: "json_schema",
      },
    },
  };
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > input.limits.maximumRequestBytes) {
    throw new DirectApiBrokerError("synthetic_test_failed", "Synthetic profile test is too large");
  }

  return {
    body,
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "OpenAI-Organization": input.organizationId,
      "OpenAI-Project": input.openAiProjectId,
    },
    method: "POST",
    redirectPolicy: "reject",
    timeoutMilliseconds: input.limits.requestTimeoutMilliseconds,
    tls: {
      minimumVersion: "TLSv1.2",
      rejectUnauthorized: true,
      serverName: "api.openai.com",
    },
    url: OPENAI_RESPONSES_URL,
  };
}

function requireHeader(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (value === undefined || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
    throw new DirectApiBrokerError(
      "synthetic_test_failed",
      "Synthetic response metadata is invalid",
    );
  }
  return value;
}

function readSyntheticMarker(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("output" in value)) return undefined;
  const output = value.output;
  if (!Array.isArray(output)) return undefined;

  for (const item of output) {
    if (typeof item !== "object" || item === null || !("content" in item)) continue;
    if (!Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (
        typeof content === "object" &&
        content !== null &&
        "type" in content &&
        content.type === "output_text" &&
        "text" in content &&
        typeof content.text === "string"
      ) {
        return content.text;
      }
    }
  }
  return undefined;
}

function validateSyntheticResponse(
  response: OpenAiTransportResponse,
  input: DirectApiCertificationInput,
): Omit<DirectApiSyntheticTest, "passedAt"> {
  if (response.statusCode === 401 || response.statusCode === 403) {
    throw new DirectApiBrokerError("credential_unavailable", "Provider credential was rejected");
  }
  if (response.statusCode !== 200) {
    throw new DirectApiBrokerError("provider_unavailable", "Provider profile test was unavailable");
  }
  if (Buffer.byteLength(response.body, "utf8") > 1_048_576) {
    throw new DirectApiBrokerError(
      "synthetic_test_failed",
      "Synthetic response exceeded its bound",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body) as unknown;
  } catch {
    throw new DirectApiBrokerError("synthetic_test_failed", "Synthetic response was not JSON");
  }
  const observedOrganizationId = requireHeader(response.headers, "openai-organization");
  const observedApiVersion = requireHeader(response.headers, "openai-version");
  const requestId = requireHeader(response.headers, "x-request-id");
  const observedModel =
    typeof parsed === "object" &&
    parsed !== null &&
    "model" in parsed &&
    typeof parsed.model === "string"
      ? parsed.model
      : "";
  const status =
    typeof parsed === "object" && parsed !== null && "status" in parsed ? parsed.status : undefined;

  if (
    observedOrganizationId !== input.organizationId ||
    observedApiVersion !== OPENAI_API_VERSION ||
    observedModel !== input.model.expectedResolvedId
  ) {
    throw new DirectApiBrokerError("identity_drift", "Observed provider profile identity drifted");
  }

  const marker = readSyntheticMarker(parsed);
  let structuredOutput: unknown;
  try {
    structuredOutput = marker === undefined ? undefined : (JSON.parse(marker) as unknown);
  } catch {
    structuredOutput = undefined;
  }
  if (
    status !== "completed" ||
    typeof structuredOutput !== "object" ||
    structuredOutput === null ||
    Array.isArray(structuredOutput) ||
    Object.keys(structuredOutput).length !== 1 ||
    !("kestrelSynthetic" in structuredOutput) ||
    structuredOutput.kestrelSynthetic !== "ok"
  ) {
    throw new DirectApiBrokerError(
      "synthetic_test_failed",
      "Synthetic structured output was invalid",
    );
  }

  return {
    observedApiVersion: OPENAI_API_VERSION,
    observedModel,
    observedOrganizationId,
    requestId,
  };
}

export async function certifyDirectApiProfile(
  input: DirectApiCertificationInput,
  transport: OpenAiTransport,
  now: () => Date = () => new Date(),
): Promise<DirectApiSyntheticTest> {
  const result = validateSyntheticResponse(await transport.send(buildRequest(input)), input);
  return { ...result, passedAt: now().toISOString() };
}
