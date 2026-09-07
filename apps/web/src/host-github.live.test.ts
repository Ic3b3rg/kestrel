import { describe, expect, it } from "vitest";

import { createHostGitHubCli } from "./host-github.js";

const liveRepository = process.env.KESTREL_LIVE_GH_REPOSITORY;
const coordinates = liveRepository?.match(
  /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/u,
);

describe.runIf(liveRepository !== undefined)("host GitHub live conformance", () => {
  it("lists and selects the expected PR from an explicitly authorized repository", async () => {
    const owner = coordinates?.[1];
    const repository = coordinates?.[2];
    if (owner === undefined || repository === undefined)
      throw new Error("Live repository is invalid");
    const number = Number(process.env.KESTREL_LIVE_GH_PR_NUMBER);
    const group = process.env.KESTREL_LIVE_GH_PR_GROUP;
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error("Set KESTREL_LIVE_GH_PR_NUMBER to a known open PR number");
    if (group !== "review_requested" && group !== "authored" && group !== "other")
      throw new Error("Set KESTREL_LIVE_GH_PR_GROUP to review_requested, authored, or other");

    const cli = createHostGitHubCli();
    const connection = await cli.readConnection({
      projectId: "018f0f89-949a-75a8-8f61-6df78a843b1e",
      coordinates: { owner, repository },
    });
    expect(connection).toMatchObject({
      state: "ready",
      reason: null,
      cli: { supported: true },
      identity: { host: "github.com" },
      projectAccess: { state: "verified" },
    });

    const inbox = await cli.readProjectInbox("018f0f89-949a-75a8-8f61-6df78a843b1e", {
      owner,
      repository,
    });

    expect(inbox.status).toMatchObject({
      availability: "available",
      authentication: "authenticated",
      host: "github.com",
    });
    expect(inbox.status.account).not.toBeNull();
    expect(inbox.pullRequests.length).toBeLessThanOrEqual(300);
    expect(inbox.groupStates).toEqual([
      { group: "review_requested", state: "available", failureReason: null },
      { group: "authored", state: "available", failureReason: null },
      { group: "other", state: "available", failureReason: null },
    ]);
    const matches = inbox.pullRequests.filter((pullRequest) => pullRequest.number === number);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      number,
      group,
      url: `https://github.com/${owner}/${repository}/pull/${String(number)}`,
    });

    const account = inbox.status.account;
    if (account === null) throw new Error("The live inbox did not report its account");
    const observation = await cli.observePullRequest({ owner, repository }, number, account);
    expect(observation.repository).toMatchObject({
      owner,
      name: repository,
      canonicalUrl: `https://github.com/${owner}/${repository}`,
    });
    expect(observation.proposal).toMatchObject({
      number,
      canonicalUrl: matches[0]?.url,
      proposalState: "open",
    });
    expect(observation.proposal.base.objectId).toMatch(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
    expect(observation.proposal.head.objectId).toMatch(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
    expect(observation.proposal.author?.login ?? null).toBe(matches[0]?.author);
  }, 30_000);
});
