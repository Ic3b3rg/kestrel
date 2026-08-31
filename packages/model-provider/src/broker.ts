import {
  DIRECT_API_FIXED_PROFILE,
  type DirectApiLimits,
  type DirectApiModelTarget,
  type DirectApiSyntheticTest,
} from "@kestrel/contracts";

export const OPENAI_RESPONSES_URL =
  `${DIRECT_API_FIXED_PROFILE.endpointOrigin}${DIRECT_API_FIXED_PROFILE.endpointPath}` as const;
export const OPENAI_API_VERSION = DIRECT_API_FIXED_PROFILE.apiVersion;

export type DirectApiBrokerErrorCode =
  | "credential_unavailable"
  | "destination_rejected"
  | "identity_drift"
  | "provider_unavailable"
  | "request_invalid"
  | "response_invalid"
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

export interface OpenAiStructuredTextRequestBody {
  readonly input: string;
  readonly instructions: string;
  readonly max_output_tokens: number;
  readonly model: string;
  readonly store: false;
  readonly text: {
    readonly format: {
      readonly name: string;
      readonly schema: Readonly<Record<string, unknown>>;
      readonly strict: true;
      readonly type: "json_schema";
    };
  };
}

export interface OpenAiTransportRequest {
  readonly body: OpenAiStructuredTextRequestBody;
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

export interface DirectApiStructuredTextInferenceInput extends DirectApiCertificationInput {
  readonly input: string;
  readonly inputTokenCount: number;
  readonly instructions: string;
  readonly output: {
    readonly name: string;
    readonly schema: Readonly<Record<string, unknown>>;
  };
}

export interface DirectApiResponseIdentity {
  readonly attributedOpenAiProjectId: string;
  readonly observedApiVersion: typeof OPENAI_API_VERSION;
  readonly observedModel: string;
  readonly observedOrganizationId: string;
  readonly requestId: string;
}

export interface DirectApiStructuredTextInferenceResult {
  readonly identity: DirectApiResponseIdentity;
  readonly output: unknown;
}

const syntheticSchema = {
  additionalProperties: false,
  properties: { kestrelSynthetic: { const: "ok", type: "string" } },
  required: ["kestrelSynthetic"],
  type: "object",
} as const;

function requestForBody(
  input: DirectApiCertificationInput,
  body: OpenAiStructuredTextRequestBody,
  invalidCode: "request_invalid" | "synthetic_test_failed",
): OpenAiTransportRequest {
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > input.limits.maximumRequestBytes) {
    throw new DirectApiBrokerError(invalidCode, "Direct API request exceeded its bound");
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

function buildSyntheticRequest(input: DirectApiCertificationInput): OpenAiTransportRequest {
  const body: OpenAiStructuredTextRequestBody = {
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
  return requestForBody(input, body, "synthetic_test_failed");
}

function requireHeader(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
  invalidCode: "response_invalid" | "synthetic_test_failed",
): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (value === undefined || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
    throw new DirectApiBrokerError(invalidCode, "Direct API response metadata is invalid");
  }
  return value;
}

function readOutputText(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("output" in value)) return undefined;
  const output = value.output;
  if (!Array.isArray(output)) return undefined;

  const outputTexts: string[] = [];
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
        outputTexts.push(content.text);
      }
    }
  }
  return outputTexts.length === 1 ? outputTexts[0] : undefined;
}

function validateResponseIdentity(
  response: OpenAiTransportResponse,
  input: DirectApiCertificationInput,
  invalidCode: "response_invalid" | "synthetic_test_failed",
): { identity: DirectApiResponseIdentity; parsed: Record<string, unknown> } {
  if (response.statusCode === 401 || response.statusCode === 403) {
    throw new DirectApiBrokerError("credential_unavailable", "Provider credential was rejected");
  }
  if (response.statusCode !== 200) {
    throw new DirectApiBrokerError("provider_unavailable", "Provider profile test was unavailable");
  }
  if (Buffer.byteLength(response.body, "utf8") > 1_048_576) {
    throw new DirectApiBrokerError(invalidCode, "Direct API response exceeded its bound");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body) as unknown;
  } catch {
    throw new DirectApiBrokerError(invalidCode, "Direct API response was not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DirectApiBrokerError(invalidCode, "Direct API response was invalid");
  }
  const observedOrganizationId = requireHeader(
    response.headers,
    "openai-organization",
    invalidCode,
  );
  const observedApiVersion = requireHeader(response.headers, "openai-version", invalidCode);
  const requestId = requireHeader(response.headers, "x-request-id", invalidCode);
  const observedModel =
    typeof parsed === "object" &&
    parsed !== null &&
    "model" in parsed &&
    typeof parsed.model === "string"
      ? parsed.model
      : "";
  if (
    observedOrganizationId !== input.organizationId ||
    observedApiVersion !== OPENAI_API_VERSION ||
    observedModel !== input.model.expectedResolvedId
  ) {
    throw new DirectApiBrokerError("identity_drift", "Observed provider profile identity drifted");
  }

  return {
    identity: {
      attributedOpenAiProjectId: input.openAiProjectId,
      observedApiVersion: OPENAI_API_VERSION,
      observedModel,
      observedOrganizationId,
      requestId,
    },
    parsed: parsed as Record<string, unknown>,
  };
}

function validateSyntheticResponse(
  response: OpenAiTransportResponse,
  input: DirectApiCertificationInput,
): Omit<DirectApiSyntheticTest, "passedAt"> {
  const { identity, parsed } = validateResponseIdentity(response, input, "synthetic_test_failed");
  const status = parsed.status;

  const marker = readOutputText(parsed);
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

  return identity;
}

export async function certifyDirectApiProfile(
  input: DirectApiCertificationInput,
  transport: OpenAiTransport,
  now: () => Date = () => new Date(),
): Promise<DirectApiSyntheticTest> {
  const result = validateSyntheticResponse(
    await transport.send(buildSyntheticRequest(input)),
    input,
  );
  return { ...result, passedAt: now().toISOString() };
}

function normalizeStrictOutputSchema(
  output: DirectApiStructuredTextInferenceInput["output"],
): Readonly<Record<string, unknown>> {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(output.name)) {
    throw new DirectApiBrokerError("request_invalid", "Structured output name was invalid");
  }
  let schema: unknown;
  try {
    const serialized = JSON.stringify(output.schema);
    if (serialized === undefined) throw new Error("Schema is not serializable");
    schema = JSON.parse(serialized) as unknown;
  } catch {
    throw new DirectApiBrokerError("request_invalid", "Structured output schema was invalid");
  }
  if (
    typeof schema !== "object" ||
    schema === null ||
    Array.isArray(schema) ||
    !("type" in schema) ||
    schema.type !== "object" ||
    !("additionalProperties" in schema) ||
    schema.additionalProperties !== false ||
    !("properties" in schema) ||
    typeof schema.properties !== "object" ||
    schema.properties === null ||
    Array.isArray(schema.properties) ||
    !("required" in schema) ||
    !Array.isArray(schema.required)
  ) {
    throw new DirectApiBrokerError("request_invalid", "Structured output schema was invalid");
  }
  const propertyNames = Object.keys(schema.properties).sort();
  const requiredNames = schema.required.filter(
    (value): value is string => typeof value === "string",
  );
  if (
    requiredNames.length !== schema.required.length ||
    new Set(requiredNames).size !== requiredNames.length ||
    propertyNames.join("\0") !== [...requiredNames].sort().join("\0")
  ) {
    throw new DirectApiBrokerError("request_invalid", "Structured output schema was invalid");
  }
  return schema as Readonly<Record<string, unknown>>;
}

function buildInferenceRequest(
  input: DirectApiStructuredTextInferenceInput,
): OpenAiTransportRequest {
  if (
    input.input.length === 0 ||
    input.instructions.length === 0 ||
    !Number.isSafeInteger(input.inputTokenCount) ||
    input.inputTokenCount < 1 ||
    input.inputTokenCount > input.limits.maximumInputTokens ||
    input.limits.maximumAttempts !== 1
  ) {
    throw new DirectApiBrokerError("request_invalid", "Structured text request was invalid");
  }
  const schema = normalizeStrictOutputSchema(input.output);
  return requestForBody(
    input,
    {
      input: input.input,
      instructions: input.instructions,
      max_output_tokens: input.limits.maximumOutputTokens,
      model: input.model.requestedId,
      store: false,
      text: {
        format: {
          name: input.output.name,
          schema,
          strict: true,
          type: "json_schema",
        },
      },
    },
    "request_invalid",
  );
}

export async function runDirectApiStructuredTextInference(
  input: DirectApiStructuredTextInferenceInput,
  transport: OpenAiTransport,
): Promise<DirectApiStructuredTextInferenceResult> {
  const { identity, parsed } = validateResponseIdentity(
    await transport.send(buildInferenceRequest(input)),
    input,
    "response_invalid",
  );
  if (parsed.status !== "completed") {
    throw new DirectApiBrokerError("response_invalid", "Structured text response was incomplete");
  }
  const outputText = readOutputText(parsed);
  let output: unknown;
  try {
    output = outputText === undefined ? undefined : (JSON.parse(outputText) as unknown);
  } catch {
    output = undefined;
  }
  if (output === undefined) {
    throw new DirectApiBrokerError("response_invalid", "Structured text response was invalid");
  }
  return { identity, output };
}
