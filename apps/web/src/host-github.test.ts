import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createHostGitHubCli, type HostGitHubError } from "./host-github.js";

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const temporaryDirectories: string[] = [];

async function fakeGh(
  mode:
    | "ok"
    | "malformed"
    | "slow"
    | "account_drift"
    | "post_access_drift"
    | "not_authenticated"
    | "old_version"
    | "rate_limited"
    | "sso_denied" = "ok",
) {
  const directory = await mkdtemp(join(tmpdir(), "kestrel-fake-gh-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "gh");
  const log = join(directory, "args.log");
  const source = `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
${mode === "slow" ? "sleep 5" : ""}
case "$1 $2" in
  "version ") ${mode === "malformed" ? "printf 'not-json'" : mode === "old_version" ? "printf 'gh version 2.39.1 (test)\\\\n'" : "printf 'gh version 2.87.0 (test)\\\\n'"} ;;
  "api --hostname")
    case "$4" in
      "/user") ${mode === "account_drift" ? `if [ -f '${join(directory, "seen-user")}' ]; then printf '{"login":"intruder"}'; else touch '${join(directory, "seen-user")}'; printf '{"login":"operator"}'; fi` : mode === "post_access_drift" ? `if [ -f '${join(directory, "repository-read")}' ]; then printf '{"login":"intruder"}'; else printf '{"login":"operator"}'; fi` : mode === "not_authenticated" ? "printf 'not logged into github.com ghp_never_expose_this' >&2; exit 1" : mode === "rate_limited" ? "printf 'API rate limit exceeded' >&2; exit 1" : 'if [ "$5" = "--jq" ]; then printf \'{"login":"operator"}\'; else printf \'{"login":"operator","name":"extra provider field"}\'; fi'} ;;
      *) ${mode === "sso_denied" ? "printf 'Resource protected by organization SAML enforcement ghp_never_expose_this' >&2; exit 1" : `${mode === "post_access_drift" ? `touch '${join(directory, "repository-read")}'; ` : ""}if [ "$5" = "--jq" ]; then printf '{"id":1,"name":"kestrel","node_id":"R_test","owner":{"login":"Ic3b3rg"}}'; else printf '{"id":1,"name":"kestrel","node_id":"R_test","owner":{"login":"Ic3b3rg"},"private":true}'; fi`} ;;
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
  it("verifies the CLI identity and real Project access with fixed read-only commands", async () => {
    const fake = await fakeGh();
    const connection = await createHostGitHubCli({
      executable: fake.executable,
    }).readConnection({
      projectId,
      coordinates: { owner: "Ic3b3rg", repository: "kestrel" },
    });

    expect(connection).toMatchObject({
      state: "ready",
      reason: null,
      cli: { version: "2.87.0", supported: true },
      identity: { host: "github.com", account: "operator" },
      projectAccess: {
        state: "verified",
        projectId,
        repository: { owner: "Ic3b3rg", name: "kestrel" },
      },
    });
    expect((await readFile(fake.log, "utf8")).trim().split("\n")).toEqual([
      "version",
      "api --hostname github.com /user --jq {login: .login}",
      "api --hostname github.com /user --jq {login: .login}",
      "api --hostname github.com /repos/Ic3b3rg/kestrel --jq {id, name, node_id, owner: {login: .owner.login}}",
      "api --hostname github.com /user --jq {login: .login}",
    ]);
    expect(JSON.stringify(connection)).not.toMatch(/token|config|environment/iu);
  });

  it("validates the host identity when no Project is selected", async () => {
    const fake = await fakeGh();
    const connection = await createHostGitHubCli({
      executable: fake.executable,
    }).readConnection(null);

    expect(connection).toMatchObject({
      state: "ready",
      reason: null,
      cli: { version: "2.87.0", supported: true },
      identity: { host: "github.com", account: "operator" },
      projectAccess: null,
    });
    expect((await readFile(fake.log, "utf8")).trim().split("\n")).toEqual([
      "version",
      "api --hostname github.com /user --jq {login: .login}",
      "api --hostname github.com /user --jq {login: .login}",
    ]);
  });

  it("keeps a selected Project unsupported until it has bounded GitHub coordinates", async () => {
    const fake = await fakeGh();
    const connection = await createHostGitHubCli({
      executable: fake.executable,
    }).readConnection({ projectId, coordinates: null });

    expect(connection).toMatchObject({
      state: "action_required",
      reason: "project_not_supported",
      identity: { host: "github.com", account: "operator" },
      projectAccess: { state: "not_verified", projectId, repository: null },
    });
    expect((await readFile(fake.log, "utf8")).trim().split("\n")).toEqual([
      "version",
      "api --hostname github.com /user --jq {login: .login}",
      "api --hostname github.com /user --jq {login: .login}",
    ]);
  });

  it("fails closed without exposing either account when the active account drifts", async () => {
    const fake = await fakeGh("account_drift");
    const connection = await createHostGitHubCli({
      executable: fake.executable,
    }).readConnection({
      projectId,
      coordinates: { owner: "Ic3b3rg", repository: "kestrel" },
    });

    expect(connection).toMatchObject({
      state: "action_required",
      reason: "account_drift",
      cli: { version: "2.87.0", supported: true },
      identity: null,
      projectAccess: { state: "not_verified", projectId, repository: null },
    });
    expect(JSON.stringify(connection)).not.toMatch(/operator|intruder/iu);
    expect(await readFile(fake.log, "utf8")).not.toMatch(/search prs|pr view/iu);
  });

  it("fails closed when the account drifts during selected-Project access", async () => {
    const fake = await fakeGh("post_access_drift");
    const connection = await createHostGitHubCli({
      executable: fake.executable,
    }).readConnection({
      projectId,
      coordinates: { owner: "Ic3b3rg", repository: "kestrel" },
    });

    expect(connection).toMatchObject({
      state: "action_required",
      reason: "account_drift",
      identity: null,
      projectAccess: { state: "not_verified", projectId, repository: null },
    });
    expect(JSON.stringify(connection)).not.toMatch(/operator|intruder/iu);
  });

  it("requires an upgrade without probing identity when the installed CLI is unsupported", async () => {
    const fake = await fakeGh("old_version");
    const connection = await createHostGitHubCli({
      executable: fake.executable,
    }).readConnection({
      projectId,
      coordinates: { owner: "Ic3b3rg", repository: "kestrel" },
    });

    expect(connection).toMatchObject({
      state: "action_required",
      reason: "cli_version_unsupported",
      cli: { version: "2.39.1", supported: false },
      identity: null,
      projectAccess: { state: "not_verified", projectId, repository: null },
    });
    expect((await readFile(fake.log, "utf8")).trim()).toBe("version");
  });

  it("reports exact authentication remediation facts without returning provider output", async () => {
    const fake = await fakeGh("not_authenticated");
    const connection = await createHostGitHubCli({
      executable: fake.executable,
    }).readConnection({
      projectId,
      coordinates: { owner: "Ic3b3rg", repository: "kestrel" },
    });

    expect(connection).toMatchObject({
      state: "action_required",
      reason: "authentication_required",
      cli: { version: "2.87.0", supported: true },
      identity: null,
      projectAccess: { state: "not_verified", projectId, repository: null },
    });
    expect(JSON.stringify(connection)).not.toMatch(/ghp_|not logged/iu);
  });

  it("reports denied Project access only after validating the account", async () => {
    const fake = await fakeGh("sso_denied");
    const connection = await createHostGitHubCli({
      executable: fake.executable,
    }).readConnection({
      projectId,
      coordinates: { owner: "Ic3b3rg", repository: "kestrel" },
    });

    expect(connection).toMatchObject({
      state: "action_required",
      reason: "project_access_denied",
      identity: { host: "github.com", account: "operator" },
      projectAccess: { state: "not_verified", projectId, repository: null },
    });
    expect(JSON.stringify(connection)).not.toMatch(/ghp_|SAML/iu);
    expect((await readFile(fake.log, "utf8")).trim().split("\n")).toEqual([
      "version",
      "api --hostname github.com /user --jq {login: .login}",
      "api --hostname github.com /user --jq {login: .login}",
      "api --hostname github.com /repos/Ic3b3rg/kestrel --jq {id, name, node_id, owner: {login: .owner.login}}",
    ]);
  });

  it.each([
    ["malformed", undefined, "unexpected_response"],
    ["rate_limited", undefined, "rate_limited"],
    ["slow", 20, "timed_out"],
  ] as const)(
    "maps a %s probe failure to bounded unavailable facts",
    async (mode, timeoutMs, reason) => {
      const fake = await fakeGh(mode);
      const connection = await createHostGitHubCli({
        executable: fake.executable,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }).readConnection({
        projectId,
        coordinates: { owner: "Ic3b3rg", repository: "kestrel" },
      });

      expect(connection).toMatchObject({ state: "unavailable", reason, identity: null });
    },
  );

  it("reports an absent CLI without exposing the executable path", async () => {
    const executable = join(tmpdir(), "kestrel-missing-gh-never-created");
    const connection = await createHostGitHubCli({ executable }).readConnection(null);

    expect(connection).toMatchObject({
      state: "unavailable",
      reason: "cli_not_installed",
      cli: null,
      identity: null,
      projectAccess: null,
    });
    expect(JSON.stringify(connection)).not.toContain(executable);
  });

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
