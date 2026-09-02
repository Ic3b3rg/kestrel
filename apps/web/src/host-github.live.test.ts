import { describe, expect, it } from "vitest";

import { createHostGitHubCli } from "./host-github.js";

const liveRepository = process.env.KESTREL_LIVE_GH_REPOSITORY;
const coordinates = liveRepository?.match(
  /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/u,
);

describe.runIf(coordinates !== undefined && coordinates !== null)(
  "host GitHub live conformance",
  () => {
    it("performs one bounded attributed read against an explicitly authorized repository", async () => {
      const owner = coordinates?.[1];
      const repository = coordinates?.[2];
      if (owner === undefined || repository === undefined)
        throw new Error("Live repository is invalid");

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
    }, 30_000);
  },
);
