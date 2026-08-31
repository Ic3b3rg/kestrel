import { describe, expect, it, vi } from "vitest";

import {
  DirectApiBrokerError,
  assertPublicProviderAddress,
  certifyDirectApiProfile,
  runDirectApiStructuredTextInference,
  type OpenAiTransport,
} from "./index.js";

const apiKey = "sk-project-exclusive-test-key-1234567890";

describe("Direct API broker", () => {
  it("certifies only the fixed OpenAI identity with a bounded synthetic structured request", async () => {
    const send = vi.fn<OpenAiTransport["send"]>(() =>
      Promise.resolve({
        body: JSON.stringify({
          model: "gpt-test-2026-08-01",
          output: [
            {
              content: [
                {
                  text: JSON.stringify({ kestrelSynthetic: "ok" }),
                  type: "output_text",
                },
              ],
              role: "assistant",
              status: "completed",
              type: "message",
            },
          ],
          status: "completed",
        }),
        headers: {
          "openai-organization": "org_example",
          "openai-version": "2020-10-01",
          "x-request-id": "req_synthetic_example",
        },
        statusCode: 200,
      }),
    );
    const transport: OpenAiTransport = { send };

    const certification = await certifyDirectApiProfile(
      {
        apiKey,
        limits: {
          maximumAttempts: 1,
          maximumConcurrentRequests: 1,
          maximumCostUsd: "2.500000",
          maximumInputTokens: 100_000,
          maximumOutputTokens: 8_192,
          maximumRequestBytes: 1_048_576,
          requestTimeoutMilliseconds: 60_000,
        },
        model: {
          expectedResolvedId: "gpt-test-2026-08-01",
          requestedId: "gpt-test-2026-08-01",
          versionPolicy: "pinned",
        },
        openAiProjectId: "proj_example",
        organizationId: "org_example",
      },
      transport,
      () => new Date("2026-08-31T12:01:00.000Z"),
    );

    expect(certification).toEqual({
      attributedOpenAiProjectId: "proj_example",
      observedApiVersion: "2020-10-01",
      observedModel: "gpt-test-2026-08-01",
      observedOrganizationId: "org_example",
      passedAt: "2026-08-31T12:01:00.000Z",
      requestId: "req_synthetic_example",
    });
    expect(send).toHaveBeenCalledOnce();
    const request = send.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      body: {
        input: "Return the Kestrel synthetic profile-test marker.",
        instructions:
          "This is a Kestrel connectivity test. Return only the required synthetic JSON object.",
        max_output_tokens: 32,
        model: "gpt-test-2026-08-01",
        store: false,
        text: {
          format: {
            name: "kestrel_profile_test",
            schema: {
              additionalProperties: false,
              properties: { kestrelSynthetic: { const: "ok", type: "string" } },
              required: ["kestrelSynthetic"],
              type: "object",
            },
            strict: true,
            type: "json_schema",
          },
        },
      },
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Organization": "org_example",
        "OpenAI-Project": "proj_example",
      },
      method: "POST",
      redirectPolicy: "reject",
      timeoutMilliseconds: 60_000,
      tls: {
        minimumVersion: "TLSv1.2",
        rejectUnauthorized: true,
        serverName: "api.openai.com",
      },
      url: "https://api.openai.com/v1/responses",
    });
    expect(request?.body).not.toHaveProperty("tools");
    expect(request?.body).not.toHaveProperty("urls");
    expect(request?.body).not.toHaveProperty("files");
    expect(JSON.stringify(request?.body)).not.toContain("repository");
  });

  it("permits only one stateless text request with privileged instructions and strict output", async () => {
    const send = vi.fn<OpenAiTransport["send"]>(() =>
      Promise.resolve({
        body: JSON.stringify({
          model: "gpt-test-2026-08-01",
          output: [
            {
              content: [
                {
                  text: JSON.stringify({ summary: "Bounded facts." }),
                  type: "output_text",
                },
              ],
              role: "assistant",
              status: "completed",
              type: "message",
            },
          ],
          status: "completed",
        }),
        headers: {
          "openai-organization": "org_example",
          "openai-version": "2020-10-01",
          "x-request-id": "req_inference_example",
        },
        statusCode: 200,
      }),
    );
    const transport: OpenAiTransport = { send };
    const inference = {
      apiKey,
      input: "A bounded fact manifest.",
      inputTokenCount: 12,
      instructions: "Organize only the supplied facts.",
      limits: {
        maximumAttempts: 1 as const,
        maximumConcurrentRequests: 1,
        maximumCostUsd: "2.500000",
        maximumInputTokens: 100_000,
        maximumOutputTokens: 8_192,
        maximumRequestBytes: 1_048_576,
        requestTimeoutMilliseconds: 60_000,
      },
      model: {
        expectedResolvedId: "gpt-test-2026-08-01",
        requestedId: "gpt-test-2026-08-01",
        versionPolicy: "pinned" as const,
      },
      openAiProjectId: "proj_example",
      organizationId: "org_example",
      output: {
        name: "change_overview",
        schema: {
          additionalProperties: false,
          properties: { summary: { type: "string" } },
          required: ["summary"],
          type: "object",
        },
      },
    };

    await expect(runDirectApiStructuredTextInference(inference, transport)).resolves.toEqual({
      identity: {
        attributedOpenAiProjectId: "proj_example",
        observedApiVersion: "2020-10-01",
        observedModel: "gpt-test-2026-08-01",
        observedOrganizationId: "org_example",
        requestId: "req_inference_example",
      },
      output: { summary: "Bounded facts." },
    });

    expect(send).toHaveBeenCalledOnce();
    const request = send.mock.calls[0]?.[0];
    expect(request?.body).toEqual({
      input: "A bounded fact manifest.",
      instructions: "Organize only the supplied facts.",
      max_output_tokens: 8_192,
      model: "gpt-test-2026-08-01",
      store: false,
      text: {
        format: {
          name: "change_overview",
          schema: {
            additionalProperties: false,
            properties: { summary: { type: "string" } },
            required: ["summary"],
            type: "object",
          },
          strict: true,
          type: "json_schema",
        },
      },
    });
    for (const forbidden of [
      "background",
      "conversation",
      "file",
      "previous_response_id",
      "prompt",
      "service_tier",
      "stream",
      "tool",
      "url",
    ]) {
      expect(JSON.stringify(request?.body)).not.toContain(forbidden);
    }

    await expect(
      runDirectApiStructuredTextInference(
        { ...inference, inputTokenCount: inference.limits.maximumInputTokens + 1 },
        transport,
      ),
    ).rejects.toMatchObject({ code: "request_invalid" });
    await expect(
      runDirectApiStructuredTextInference(
        {
          ...inference,
          output: {
            ...inference.output,
            schema: { ...inference.output.schema, additionalProperties: true },
          },
        },
        transport,
      ),
    ).rejects.toMatchObject({ code: "request_invalid" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("fails closed on observed profile drift without exposing the credential", async () => {
    const send = vi.fn<OpenAiTransport["send"]>(() =>
      Promise.resolve({
        body: JSON.stringify({
          model: "gpt-floating",
          output: [],
          status: "completed",
        }),
        headers: {
          "openai-organization": "org_other",
          "openai-version": "2020-10-01",
          "x-request-id": "req_drift",
        },
        statusCode: 200,
      }),
    );
    const transport: OpenAiTransport = { send };

    const attempt = certifyDirectApiProfile(
      {
        apiKey,
        limits: {
          maximumAttempts: 1,
          maximumConcurrentRequests: 1,
          maximumCostUsd: "1",
          maximumInputTokens: 1,
          maximumOutputTokens: 32,
          maximumRequestBytes: 1_024,
          requestTimeoutMilliseconds: 1_000,
        },
        model: {
          expectedResolvedId: "gpt-test-2026-08-01",
          requestedId: "gpt-test-2026-08-01",
          versionPolicy: "pinned",
        },
        openAiProjectId: "proj_example",
        organizationId: "org_example",
      },
      transport,
    );

    await expect(attempt).rejects.toMatchObject({
      code: "identity_drift",
    } satisfies Partial<DirectApiBrokerError>);
    await expect(attempt).rejects.not.toThrow(apiKey);
  });

  it("rejects private, local, and invalid resolved provider addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fd00::1"])
      expect(() => assertPublicProviderAddress(address)).toThrow(DirectApiBrokerError);

    expect(() => assertPublicProviderAddress("not-an-ip")).toThrow(DirectApiBrokerError);
    expect(() => assertPublicProviderAddress("104.18.6.192")).not.toThrow();
    expect(() => assertPublicProviderAddress("2606:4700::6812:7c0")).not.toThrow();
  });
});
