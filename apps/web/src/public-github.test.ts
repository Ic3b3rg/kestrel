import { describe, expect, it, vi } from "vitest";

import {
  PublicGitHubReadError,
  createPublicGitHubReader,
  parsePublicGitHubPullRequestUrl,
} from "./public-github.js";

const pullRequestUrl = "https://github.com/openai/openai-node/pull/1234";

function pullRequestResponse(overrides: Record<string, unknown> = {}) {
  return {
    base: {
      ref: "main",
      repo: {
        full_name: "openai/openai-node",
        name: "openai-node",
        node_id: "R_kgDOGx",
        owner: { login: "openai" },
        private: false,
      },
      sha: "a".repeat(40),
    },
    head: { ref: "provider-observation", sha: "b".repeat(40) },
    merged: false,
    merged_at: null,
    node_id: "PR_kwDOGx",
    number: 1234,
    state: "open",
    title: "Keep repository access explicit",
    user: { login: "octocat", node_id: "U_kgDOA" },
    ...overrides,
  };
}

function privatePullRequestResponse() {
  const response = pullRequestResponse();
  return {
    ...response,
    base: {
      ...response.base,
      repo: { ...response.base.repo, private: true },
    },
  };
}

function inconsistentRepositoryResponse() {
  const response = pullRequestResponse();
  return {
    ...response,
    base: {
      ...response.base,
      repo: {
        ...response.base.repo,
        name: "different-repository",
        owner: { login: "different-owner" },
      },
    },
  };
}

describe("public GitHub reader", () => {
  it("derives one fixed API target and normalizes the untrusted response", async () => {
    const fetchImplementation = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(input).toBe("https://api.github.com/repos/openai/openai-node/pulls/1234");
      expect(init).toMatchObject({
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Kestrel-Review-First-V1",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        method: "GET",
        redirect: "manual",
      });
      expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
      return Promise.resolve(Response.json(pullRequestResponse()));
    });

    const reader = createPublicGitHubReader(fetchImplementation);

    await expect(reader.read(pullRequestUrl)).resolves.toEqual({
      proposal: {
        author: { login: "octocat", providerId: "U_kgDOA" },
        base: { objectId: "a".repeat(40), ref: "main" },
        canonicalUrl: pullRequestUrl,
        head: { objectId: "b".repeat(40), ref: "provider-observation" },
        number: 1234,
        proposalState: "open",
        providerId: "PR_kwDOGx",
        title: "Keep repository access explicit",
      },
      repository: {
        canonicalUrl: "https://github.com/openai/openai-node",
        name: "openai-node",
        owner: "openai",
        providerId: "R_kgDOGx",
      },
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("parses only the canonical contract form", () => {
    expect(parsePublicGitHubPullRequestUrl(pullRequestUrl)).toEqual({
      number: 1234,
      owner: "openai",
      repository: "openai-node",
    });
    expect(() =>
      parsePublicGitHubPullRequestUrl(
        "https://github.com.evil.example/openai/openai-node/pull/1234",
      ),
    ).toThrow();
  });

  it.each([
    [301, "redirected"],
    [404, "not_found"],
    [429, "rate_limited"],
  ] as const)("classifies GitHub status %i as %s", async (status, kind) => {
    const reader = createPublicGitHubReader(
      vi.fn(() =>
        Promise.resolve(new Response(null, { headers: { location: "http://127.0.0.1" }, status })),
      ),
    );

    const error = await reader.read(pullRequestUrl).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(PublicGitHubReadError);
    expect(error).toMatchObject({ kind });
  });

  it("recognizes a primary rate-limit response without trusting its body", async () => {
    const reader = createPublicGitHubReader(
      vi.fn(() =>
        Promise.resolve(
          new Response("not json", {
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1787673600" },
            status: 403,
          }),
        ),
      ),
    );

    await expect(reader.read(pullRequestUrl)).rejects.toMatchObject({
      kind: "rate_limited",
      rateLimitReset: "1787673600",
    });
  });

  it.each([
    pullRequestResponse({ number: 999 }),
    privatePullRequestResponse(),
    inconsistentRepositoryResponse(),
    pullRequestResponse({ title: "x".repeat(513) }),
  ])("rejects mismatched, private, or over-bound provider data", async (providerBody) => {
    const reader = createPublicGitHubReader(
      vi.fn(() => Promise.resolve(Response.json(providerBody))),
    );

    await expect(reader.read(pullRequestUrl)).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("bounds the provider response before parsing JSON", async () => {
    const reader = createPublicGitHubReader(
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ padding: "x".repeat(1_048_576) }), {
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );

    await expect(reader.read(pullRequestUrl)).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("classifies a response stream failure as public GitHub unavailability", async () => {
    const reader = createPublicGitHubReader(
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("response stream failed"));
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );

    await expect(reader.read(pullRequestUrl)).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});
