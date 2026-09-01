import { describe, expect, it, vi } from "vitest";

import { DirectApiBrokerError, type OpenAiTransport } from "@kestrel/model-provider";

import {
  CHANGE_OVERVIEW_KESTREL_P95_TARGET_MILLISECONDS,
  CHANGE_OVERVIEW_RENDER_MAXIMUM_OUTPUT_TOKENS,
  CHANGE_OVERVIEW_RENDER_WORK_OPTIONS,
  createChangeOverviewRenderer,
  type ChangeOverviewRenderingPersistence,
} from "./change-overview-renderer.js";

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const proposalId = "018f0f89-9192-755f-aa96-f72094c734dd";
const revisionId = "018f0f89-9a21-7271-b92d-f1cb0d48bb47";
const generationToken = "018f0f89-9a23-7d64-a5dd-18cc3e317401";
const job = {
  changeProposalId: proposalId,
  correlationId: "018f0f89-949a-75a8-8f61-6df78a843b1f",
  exactHeadObjectId: "b".repeat(40),
  generationToken,
  projectId,
  reviewRevisionId: revisionId,
};

const claimed = {
  exactRevision: {
    objectFormat: "sha1" as const,
    base: {
      author: "Base Author",
      objectId: "a".repeat(40),
      ref: "refs/heads/main",
      subject: "Base subject",
    },
    head: {
      author: "Head Author",
      objectId: "b".repeat(40),
      ref: "refs/heads/change",
      subject: "Head subject",
    },
  },
  projectId,
  queueMilliseconds: 25,
  requestedAt: new Date("2026-08-24T12:00:00.000Z"),
  sourceFacts: {
    ruleVersion: 1 as const,
    commitStatistics: { baseTreeFileCount: 2, headTreeFileCount: 3 },
    fileStatistics: { added: 0, modified: 1, deleted: 0, total: 1 },
    changedFiles: [
      {
        path: "src/review.ts",
        status: "modified" as const,
        base: { mode: "100644" as const, objectId: "c".repeat(40), type: "blob" as const },
        head: { mode: "100644" as const, objectId: "d".repeat(40), type: "blob" as const },
      },
    ],
    pathAreas: [{ pathPrefix: "src", changedFileCount: 1, samplePaths: ["src/review.ts"] }],
    warnings: [],
  },
  startedAt: new Date("2026-08-24T12:00:00.025Z"),
};

const profileReference = {
  credentialHandle: `cred_${"a".repeat(43)}`,
  profile: {
    availability: "available" as const,
    effectiveIdentity: {
      model: {
        expectedResolvedId: "gpt-test-2026-08-01",
        requestedId: "gpt-test-2026-08-01",
        versionPolicy: "pinned" as const,
      },
      openAiProjectId: "proj_test",
      organizationId: "org_test",
    },
    limits: {
      maximumAttempts: 1 as const,
      maximumConcurrentRequests: 1,
      maximumCostUsd: "1.00",
      maximumInputTokens: 20_000,
      maximumOutputTokens: 4_096,
      maximumRequestBytes: 65_536,
      requestTimeoutMilliseconds: 60_000,
    },
    projectId,
  },
};

type ProfileReadResult = Awaited<ReturnType<ChangeOverviewRenderingPersistence["readProfile"]>>;

function persistence(
  options: {
    claim?: typeof claimed | null;
    reference?: ProfileReadResult["reference"];
  } = {},
) {
  const claim = vi.fn(() => Promise.resolve(options.claim === undefined ? claimed : options.claim));
  const complete = vi.fn(() => Promise.resolve(true));
  const readProfile = vi.fn(() =>
    Promise.resolve({
      projectFound: true,
      reference: options.reference === undefined ? (profileReference as never) : options.reference,
    }),
  );
  return {
    adapter: { claim, complete, readProfile } satisfies ChangeOverviewRenderingPersistence,
    claim,
    complete,
    readProfile,
  };
}

function successfulResponse(output: unknown) {
  return {
    body: JSON.stringify({
      model: "gpt-test-2026-08-01",
      output: [{ content: [{ text: JSON.stringify(output), type: "output_text" }] }],
      status: "completed",
    }),
    headers: {
      "openai-organization": "org_test",
      "openai-version": "2020-10-01",
      "x-request-id": "req_overview_1",
    },
    statusCode: 200,
  };
}

describe("Change Overview renderer", () => {
  it("persists validated sentences with model and Kestrel latency separated", async () => {
    expect(CHANGE_OVERVIEW_RENDER_WORK_OPTIONS).toMatchObject({
      localConcurrency: 1,
      maxPriority: -1,
    });
    expect(CHANGE_OVERVIEW_KESTREL_P95_TARGET_MILLISECONDS).toBe(250);
    const store = persistence();
    const send = vi.fn<OpenAiTransport["send"]>((request) => {
      const manifest = JSON.parse(request.body.input) as { facts: Array<{ id: string }> };
      expect(manifest.facts.map(({ id }) => id)).toContain("file_statistics");
      expect(request.body.input).not.toContain("repositoryContent");
      expect(request.body).not.toHaveProperty("tools");
      expect(request.body.max_output_tokens).toBe(CHANGE_OVERVIEW_RENDER_MAXIMUM_OUTPUT_TOKENS);
      return Promise.resolve(
        successfulResponse({
          sentences: [
            {
              text: "The retained change modifies 1 file.",
              sourceFactIds: ["file_statistics"],
            },
          ],
        }),
      );
    });
    const clock = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(25)
      .mockReturnValueOnce(1_025)
      .mockReturnValueOnce(1_150);
    const renderer = createChangeOverviewRenderer({
      clock,
      credentialStore: { read: vi.fn(() => Promise.resolve("sk-test-key")) },
      persistence: store.adapter,
      transport: { send },
    });

    await expect(renderer.process(job)).resolves.toBe("ready");
    expect(store.complete).toHaveBeenCalledWith(job, {
      kind: "ready",
      kestrelMilliseconds: 150,
      modelMilliseconds: 1_000,
      providerRequestId: "req_overview_1",
      queueMilliseconds: 25,
      sentences: [
        {
          text: "The retained change modifies 1 file.",
          sourceFactIds: ["file_statistics"],
        },
      ],
    });
  });

  it("fails the whole rendering when model text makes a behavioral claim", async () => {
    const store = persistence();
    const send = vi.fn<OpenAiTransport["send"]>(() =>
      Promise.resolve(
        successfulResponse({
          sentences: [
            {
              text: "The change prevents unauthorized access.",
              sourceFactIds: ["file_statistics"],
            },
          ],
        }),
      ),
    );
    const renderer = createChangeOverviewRenderer({
      clock: vi.fn(() => 0),
      credentialStore: { read: vi.fn(() => Promise.resolve("sk-test-key")) },
      persistence: store.adapter,
      transport: { send },
    });

    await expect(renderer.process(job)).resolves.toBe("unavailable");
    expect(store.complete).toHaveBeenCalledWith(
      job,
      expect.objectContaining({ kind: "unavailable", reason: "invalid_rendering" }),
    );
  });

  it("leaves facts usable when no exact profile is configured", async () => {
    const store = persistence({ reference: null });
    const send = vi.fn<OpenAiTransport["send"]>();
    const renderer = createChangeOverviewRenderer({
      clock: vi.fn(() => 0),
      credentialStore: { read: vi.fn(() => Promise.resolve("")) },
      persistence: store.adapter,
      transport: { send },
    });

    await expect(renderer.process(job)).resolves.toBe("unavailable");
    expect(send).not.toHaveBeenCalled();
    expect(store.complete).toHaveBeenCalledWith(
      job,
      expect.objectContaining({ kind: "unavailable", reason: "profile_not_configured" }),
    );
  });

  it("does no model work for a superseded Proposal/head", async () => {
    const store = persistence({ claim: null });
    const renderer = createChangeOverviewRenderer({
      credentialStore: { read: vi.fn(() => Promise.resolve("")) },
      persistence: store.adapter,
      transport: { send: vi.fn<OpenAiTransport["send"]>() },
    });

    await expect(renderer.process(job)).resolves.toBe("superseded");
    expect(store.readProfile).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });

  it("reports a model timeout without retrying or publishing partial text", async () => {
    const store = persistence();
    const send = vi.fn<OpenAiTransport["send"]>(() =>
      Promise.reject(new DirectApiBrokerError("request_timeout", "Model request timed out")),
    );
    const renderer = createChangeOverviewRenderer({
      clock: vi.fn(() => 0),
      credentialStore: { read: vi.fn(() => Promise.resolve("sk-test-key")) },
      persistence: store.adapter,
      transport: { send },
    });

    await expect(renderer.process(job)).resolves.toBe("unavailable");
    expect(send).toHaveBeenCalledOnce();
    expect(store.complete).toHaveBeenCalledWith(
      job,
      expect.objectContaining({ kind: "unavailable", reason: "timed_out" }),
    );
  });
});
