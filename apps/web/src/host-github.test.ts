import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createHostGitHubCli, type HostGitHubError } from "./host-github.js";

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const temporaryDirectories: string[] = [];

async function fakeGh(
  mode: "ok" | "malformed" | "slow" | "account_drift" | "rate_limited" | "sso_denied" = "ok",
) {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-fake-gh-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "gh");
  const log = join(directory, "args.log");
  const source = `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
${mode === "slow" ? "sleep 5" : ""}
${mode === "malformed" ? "printf 'not-json'; exit 0" : ""}
${mode === "rate_limited" ? "printf 'API rate limit exceeded' >&2; exit 1" : ""}
${mode === "sso_denied" ? "printf 'Resource protected by organization SAML enforcement' >&2; exit 1" : ""}
case "$1 $2" in
  "version ") printf 'gh version 2.87.0 (test)\\n' ;;
  "api --hostname")
    case "$4" in
      "/user") ${mode === "account_drift" ? `if [ -f '${join(directory, "seen-user")}' ]; then printf '{"login":"intruder"}'; else touch '${join(directory, "seen-user")}'; printf '{"login":"operator"}'; fi` : 'printf \'{"login":"operator"}\''} ;;
      *) printf '{"id":1,"name":"kestrel","node_id":"R_test","owner":{"login":"Ic3b3rg"}}' ;;
    esac ;;
  "search prs")
    case "$*" in
      *"--review-requested @me"*) printf '[{"author":{"login":"reviewer"},"body":"review body","number":2,"title":"Review me","updatedAt":"2026-08-27T10:00:00Z","url":"https://github.com/Ic3b3rg/kestrel/pull/2"}]' ;;
      *"--author @me"*) printf '[{"author":{"login":"operator"},"body":"authored body","number":1,"title":"Mine","updatedAt":"2026-08-27T11:00:00Z","url":"https://github.com/Ic3b3rg/kestrel/pull/1"}]' ;;
      *) printf '[{"author":{"login":"operator"},"body":"authored body","number":1,"title":"Mine","updatedAt":"2026-08-27T11:00:00Z","url":"https://github.com/Ic3b3rg/kestrel/pull/1"}]' ;;
    esac ;;
  "pr view") printf '{"author":{"id":"U_test","login":"operator"},"baseRefName":"master","baseRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","body":"body","headRefName":"feature","headRefOid":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","id":"PR_test","mergedAt":null,"number":1,"state":"OPEN","title":"Mine","url":"https://github.com/Ic3b3rg/kestrel/pull/1"}' ;;
esac
`;
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { executable, log };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("host GitHub CLI", () => {
  it("uses bounded fixed read commands and groups requested, authored, then other", async () => {
    const fake = await fakeGh();
    const inbox = await createHostGitHubCli({ executable: fake.executable }).readProjectInbox(
      projectId,
      { owner: "Ic3b3rg", repository: "kestrel" },
    );

    expect(inbox.status).toMatchObject({
      account: "operator",
      authentication: "authenticated",
      executableVersion: "2.87.0",
      host: "github.com",
    });
    expect(inbox.pullRequests.map(({ number, group }) => [number, group])).toEqual([
      [2, "review_requested"],
      [1, "authored"],
    ]);
    const commands = await readFile(fake.log, "utf8");
    expect(commands).toContain("api --hostname github.com /repos/Ic3b3rg/kestrel");
    expect(commands.match(/search prs/g)).toHaveLength(3);
    expect(commands).not.toMatch(/token|auth status|--show-token/iu);
    expect(commands).not.toMatch(
      /(?:--method|-X)\s+(?:POST|PATCH|PUT|DELETE)|\bpr\s+(?:merge|close|comment|review)\b/iu,
    );
  });

  it("rejects malformed output without exposing it", async () => {
    const fake = await fakeGh("malformed");
    await expect(
      createHostGitHubCli({ executable: fake.executable }).readProjectInbox(projectId, {
        owner: "Ic3b3rg",
        repository: "kestrel",
      }),
    ).rejects.toEqual(expect.objectContaining({ kind: "invalid_response" }));
  });

  it("terminates a timed-out command", async () => {
    const fake = await fakeGh("slow");
    await expect(
      createHostGitHubCli({ executable: fake.executable, timeoutMs: 20 }).readProjectInbox(
        projectId,
        { owner: "Ic3b3rg", repository: "kestrel" },
      ),
    ).rejects.toEqual(
      expect.objectContaining({ kind: "timeout" } satisfies Partial<HostGitHubError>),
    );
  });

  it("honors cancellation before spawning", async () => {
    const fake = await fakeGh();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createHostGitHubCli({ executable: fake.executable }).readProjectInbox(
        projectId,
        { owner: "Ic3b3rg", repository: "kestrel" },
        controller.signal,
      ),
    ).rejects.toEqual(expect.objectContaining({ kind: "cancelled" }));
  });

  it("terminates an in-flight command on cancellation", async () => {
    const fake = await fakeGh("slow");
    const controller = new AbortController();
    const pending = createHostGitHubCli({
      executable: fake.executable,
      timeoutMs: 1_000,
    }).readProjectInbox(projectId, { owner: "Ic3b3rg", repository: "kestrel" }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toEqual(expect.objectContaining({ kind: "cancelled" }));
  });

  it("classifies rate limits without returning provider output", async () => {
    const fake = await fakeGh("rate_limited");
    await expect(
      createHostGitHubCli({ executable: fake.executable }).readProjectInbox(projectId, {
        owner: "Ic3b3rg",
        repository: "kestrel",
      }),
    ).rejects.toEqual(expect.objectContaining({ kind: "rate_limited" }));
  });

  it("classifies SSO policy denial without exposing provider output", async () => {
    const fake = await fakeGh("sso_denied");
    await expect(
      createHostGitHubCli({ executable: fake.executable }).readProjectInbox(projectId, {
        owner: "Ic3b3rg",
        repository: "kestrel",
      }),
    ).rejects.toEqual(expect.objectContaining({ kind: "access_denied" }));
  });

  it("fails closed when the active account drifts before selection", async () => {
    const fake = await fakeGh("account_drift");
    const cli = createHostGitHubCli({ executable: fake.executable });
    expect(await cli.readActiveAccount()).toBe("operator");
    await expect(
      cli.observePullRequest({ owner: "Ic3b3rg", repository: "kestrel" }, 1, "operator"),
    ).rejects.toEqual(expect.objectContaining({ kind: "access_denied" }));
  });

  it("observes one pull request using read-only commands only", async () => {
    const fake = await fakeGh();
    const observation = await createHostGitHubCli({
      executable: fake.executable,
    }).observePullRequest({ owner: "Ic3b3rg", repository: "kestrel" }, 1, "operator");
    expect(observation.proposal).toMatchObject({ number: 1, body: "body" });
    const commands = await readFile(fake.log, "utf8");
    expect(commands).toContain("pr view 1 --repo Ic3b3rg/kestrel");
    expect(commands).not.toMatch(
      /(?:--method|-X)\s+(?:POST|PATCH|PUT|DELETE)|\bpr\s+(?:merge|close|comment|review)\b/iu,
    );
  });
});
