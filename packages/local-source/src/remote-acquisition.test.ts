import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { readLocalSourceConfig, readRawGitObject, withGitHubPullRequestObjects } from "./index.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const servers: Server[] = [];

async function startAuthenticatedGitServer(repositoryRoot: string): Promise<{
  remote: string;
  stats: { authenticatedRequests: number; challenges: number };
}> {
  const expectedAuthorization = `Basic ${Buffer.from("kestrel:private-review").toString("base64")}`;
  const stats = { authenticatedRequests: 0, challenges: 0 };
  const server = createServer((request, response) => {
    if (request.headers.authorization !== expectedAuthorization) {
      stats.challenges += 1;
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Kestrel test"' });
      response.end();
      return;
    }
    stats.authenticatedRequests += 1;
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const gitProtocol = request.headers["git-protocol"];
    const backend = spawn("/usr/bin/git", ["http-backend"], {
      env: {
        ...process.env,
        CONTENT_LENGTH: request.headers["content-length"] ?? "",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        GIT_HTTP_EXPORT_ALL: "1",
        GIT_PROJECT_ROOT: repositoryRoot,
        HTTP_GIT_PROTOCOL: typeof gitProtocol === "string" ? gitProtocol : "",
        PATH_INFO: requestUrl.pathname,
        QUERY_STRING: requestUrl.search.slice(1),
        REMOTE_ADDR: request.socket.remoteAddress ?? "127.0.0.1",
        REMOTE_USER: "kestrel",
        REQUEST_METHOD: request.method ?? "GET",
        SERVER_NAME: "127.0.0.1",
        SERVER_PORT: String(request.socket.localPort ?? 80),
        SERVER_PROTOCOL: `HTTP/${request.httpVersion}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    backend.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    backend.stderr.resume();
    backend.once("error", (error) => response.destroy(error));
    backend.once("close", (exitCode) => {
      if (exitCode !== 0) {
        response.writeHead(500);
        response.end();
        return;
      }
      const output = Buffer.concat(stdout);
      const separator = output.indexOf(Buffer.from("\r\n\r\n"));
      const fallbackSeparator = separator === -1 ? output.indexOf(Buffer.from("\n\n")) : -1;
      const headerEnd = separator === -1 ? fallbackSeparator : separator;
      const separatorBytes = separator === -1 ? 2 : 4;
      if (headerEnd === -1) {
        response.writeHead(500);
        response.end();
        return;
      }
      let status = 200;
      for (const line of output.subarray(0, headerEnd).toString("utf8").split(/\r?\n/u)) {
        const headerSeparator = line.indexOf(":");
        if (headerSeparator === -1) continue;
        const name = line.slice(0, headerSeparator);
        const value = line.slice(headerSeparator + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else response.setHeader(name, value);
      }
      response.writeHead(status);
      response.end(output.subarray(headerEnd + separatorBytes));
    });
    request.pipe(backend.stdin);
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Git test server unavailable");
  return { remote: `http://127.0.0.1:${String(address.port)}/remote.git`, stats };
}

async function git(repository: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/git", ["-C", repository, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function createFixture(options: { authenticated?: boolean; hangOnFetch?: boolean } = {}) {
  const fixture = await mkdtemp(join(tmpdir(), "kestrel-remote-acquisition-"));
  temporaryDirectories.push(fixture);
  const artifacts = join(fixture, "artifacts");
  const localRoot = join(fixture, "local-root");
  const source = join(fixture, "source");
  const remote = join(fixture, "remote.git");
  const log = join(fixture, "git-log.jsonl");
  const fetchStarted = join(fixture, "fetch-started");
  const credentialHelper = join(fixture, "credential-helper.cjs");
  const credentialHelperLog = join(fixture, "credential-helper.log");
  const wrapper = join(fixture, "git-wrapper.cjs");
  await Promise.all([
    mkdir(artifacts, { mode: 0o700 }),
    mkdir(localRoot),
    mkdir(source),
    mkdir(remote),
  ]);
  await chmod(artifacts, 0o700);
  await git(source, ["init", "--initial-branch=main"]);
  await git(source, ["config", "user.name", "Kestrel Test"]);
  await git(source, ["config", "user.email", "kestrel@example.invalid"]);
  await writeFile(join(source, "review.txt"), "base\n", "utf8");
  await git(source, ["add", "review.txt"]);
  await git(source, ["commit", "-m", "Base"]);
  const baseObjectId = await git(source, ["rev-parse", "HEAD"]);
  await git(source, ["switch", "-c", "review-source"]);
  await writeFile(join(source, "review.txt"), "head\n", "utf8");
  await git(source, ["commit", "-am", "Head"]);
  const headObjectId = await git(source, ["rev-parse", "HEAD"]);
  await git(remote, ["init", "--bare"]);
  await git(source, ["push", remote, "main:refs/heads/main"]);
  await git(source, ["push", remote, "review-source:refs/pull/42/head"]);

  const canonicalRemote = "https://github.com/kestrel/review-source.git";
  const authenticatedServer =
    options.authenticated === true ? await startAuthenticatedGitServer(fixture) : null;
  await writeFile(
    credentialHelper,
    `#!${process.execPath}\n` +
      `const { appendFileSync } = require("node:fs");\n` +
      `const action = process.argv[2] ?? "";\n` +
      `appendFileSync(${JSON.stringify(credentialHelperLog)}, action + "\\n");\n` +
      `if (action === "get") process.stdout.write("username=kestrel\\npassword=private-review\\n");\n`,
    { mode: 0o700 },
  );
  await chmod(credentialHelper, 0o700);
  await writeFile(
    wrapper,
    `#!${process.execPath}\n` +
      `const { appendFileSync, writeFileSync } = require("node:fs");\n` +
      `const { spawnSync } = require("node:child_process");\n` +
      `const args = process.argv.slice(2);\n` +
      `const config = {};\n` +
      `for (const [key, value] of Object.entries(process.env)) {\n` +
      `  if (key.startsWith("GIT_CONFIG_") || key === "GIT_TERMINAL_PROMPT" || key === "GIT_ASKPASS") config[key] = value;\n` +
      `}\n` +
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, config }) + "\\n");\n` +
      `if (args.includes("config") && args.includes("--get-regexp")) {\n` +
      (options.authenticated === true
        ? `  if (args.includes("--system")) { process.stdout.write(${JSON.stringify(`credential.helper\n${credentialHelper}\0`)}); process.exit(0); }\n`
        : `  if (args.includes("--global")) { process.stdout.write("credential.https://github.com.helper\\ntest-keychain\\0"); process.exit(0); }\n`) +
      `  process.exit(1);\n` +
      `}\n` +
      (options.hangOnFetch === true
        ? `if (args.includes("fetch")) { writeFileSync(${JSON.stringify(fetchStarted)}, "started"); setInterval(() => {}, 1000); }\n`
        : "") +
      `const mapped = args.map((value) => value === ${JSON.stringify(canonicalRemote)} ? ${JSON.stringify(authenticatedServer?.remote ?? pathToFileURL(remote).href)} : value === ${JSON.stringify(options.authenticated === true ? "protocol.http.allow=never" : "protocol.file.allow=never")} ? ${JSON.stringify(options.authenticated === true ? "protocol.http.allow=always" : "protocol.file.allow=always")} : value);\n` +
      `const result = spawnSync("/usr/bin/git", mapped, { env: process.env, stdio: "inherit" });\n` +
      `process.exit(result.status ?? 1);\n`,
    { mode: 0o700 },
  );
  await chmod(wrapper, 0o700);

  const config = await readLocalSourceConfig({
    ARTIFACT_ROOT: artifacts,
    LOCAL_GIT_EXECUTABLE: wrapper,
    LOCAL_REPOSITORY_ROOTS: JSON.stringify([localRoot]),
    REVIEW_REVISION_MAX_BYTES: "1048576",
    REVIEW_REVISION_MAX_OBJECTS: "1000",
  });
  return {
    artifacts,
    baseObjectId,
    canonicalRemote,
    config,
    credentialHelper,
    credentialHelperLog,
    fetchStarted,
    headObjectId,
    log,
    remote,
    serverStats: authenticatedServer?.stats ?? null,
  };
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await lstat(path).catch(() => null)) !== null) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
          server.closeAllConnections();
        }),
    ),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("GitHub pull-request object acquisition", () => {
  it("fetches fixed refs into a Project-scoped bare repository and removes it afterward", async () => {
    const fixture = await createFixture();
    const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
    let acquiredPath = "";

    const contents = await withGitHubPullRequestObjects(
      fixture.config,
      {
        base: { objectId: fixture.baseObjectId, ref: "main" },
        head: { objectId: fixture.headObjectId, ref: "review-source" },
        objectFormat: "sha1",
        projectId,
        pullRequestNumber: 42,
        repository: { name: "review-source", owner: "kestrel" },
      },
      async (acquired) => {
        acquiredPath = acquired.repository.path;
        expect(
          relative(join(fixture.config.artifactRoot, "projects", projectId), acquiredPath),
        ).not.toMatch(/^\.\./u);
        const [base, head] = await Promise.all([
          readRawGitObject(
            fixture.config,
            acquired.repository,
            acquired.inspection.objectFormat,
            fixture.baseObjectId,
            acquired.inspection.objectDirectories,
          ),
          readRawGitObject(
            fixture.config,
            acquired.repository,
            acquired.inspection.objectFormat,
            fixture.headObjectId,
            acquired.inspection.objectDirectories,
          ),
        ]);
        return [base.type, head.type];
      },
    );

    expect(contents).toEqual(["commit", "commit"]);
    await expect(lstat(acquiredPath)).rejects.toMatchObject({ code: "ENOENT" });

    const entries = (await readFile(fixture.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; config: Record<string, string> });
    const fetch = entries.find(({ args }) => args.includes("fetch"));
    expect(fetch?.args).toEqual(
      expect.arrayContaining([
        "--atomic",
        "--no-auto-maintenance",
        "--no-recurse-submodules",
        "--no-tags",
        "--no-write-fetch-head",
        "--refmap=",
        fixture.canonicalRemote,
        "+refs/heads/main:refs/kestrel/base",
        "+refs/pull/42/head:refs/kestrel/head",
      ]),
    );
    expect(fetch?.config).toMatchObject({
      GIT_ASKPASS: "/usr/bin/false",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(Object.values(fetch?.config ?? {})).toContain("credential.https://github.com.helper");
    expect(Object.values(fetch?.config ?? {})).toContain("test-keychain");
  });

  it("uses a system-scoped host helper to answer an authenticated private fetch challenge", async () => {
    const fixture = await createFixture({ authenticated: true });

    await expect(
      withGitHubPullRequestObjects(
        fixture.config,
        {
          base: { objectId: fixture.baseObjectId, ref: "main" },
          head: { objectId: fixture.headObjectId, ref: "review-source" },
          objectFormat: "sha1",
          projectId: "018f0f89-949a-75a8-8f61-6df78a843b1e",
          pullRequestNumber: 42,
          repository: { name: "review-source", owner: "kestrel" },
        },
        () => Promise.resolve(undefined),
      ),
    ).resolves.toBeUndefined();

    if (fixture.serverStats === null) throw new Error("Authenticated Git server unavailable");
    expect(fixture.serverStats.authenticatedRequests).toBeGreaterThan(0);
    expect(fixture.serverStats.challenges).toBeGreaterThan(0);
    await expect(readFile(fixture.credentialHelperLog, "utf8")).resolves.toContain("get\n");
    const executionLog = await readFile(fixture.log, "utf8");
    expect(executionLog).toContain(fixture.credentialHelper);
    expect(executionLog).not.toContain("private-review");
  });

  it("does not turn a completed action into failure when disposable cleanup fails", async () => {
    const fixture = await createFixture();
    let acquisitionParent = "";
    let acquisitionPath = "";
    try {
      await expect(
        withGitHubPullRequestObjects(
          fixture.config,
          {
            base: { objectId: fixture.baseObjectId, ref: "main" },
            head: { objectId: fixture.headObjectId, ref: "review-source" },
            objectFormat: "sha1",
            projectId: "018f0f89-949a-75a8-8f61-6df78a843b1e",
            pullRequestNumber: 42,
            repository: { name: "review-source", owner: "kestrel" },
          },
          async (acquired) => {
            acquisitionPath = acquired.repository.rootPath;
            acquisitionParent = dirname(acquisitionPath);
            await chmod(acquisitionParent, 0o500);
            return "published";
          },
        ),
      ).resolves.toBe("published");
    } finally {
      if (acquisitionParent !== "") await chmod(acquisitionParent, 0o700);
      if (acquisitionPath !== "") await rm(acquisitionPath, { force: true, recursive: true });
    }
  });

  it("rejects a missing pull-request ref without leaving a usable repository", async () => {
    const fixture = await createFixture();
    const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
    await git(fixture.remote, ["update-ref", "-d", "refs/pull/42/head"]);

    await expect(
      withGitHubPullRequestObjects(
        fixture.config,
        {
          base: { objectId: fixture.baseObjectId, ref: "main" },
          head: { objectId: fixture.headObjectId, ref: "review-source" },
          objectFormat: "sha1",
          projectId,
          pullRequestNumber: 42,
          repository: { name: "review-source", owner: "kestrel" },
        },
        () => Promise.resolve(undefined),
      ),
    ).rejects.toMatchObject({ code: "reference_not_available" });
    await expect(
      readdir(join(fixture.config.artifactRoot, "projects", projectId, "acquisition-repositories")),
    ).resolves.toEqual([]);
  });

  it("kills a cancelled fetch and removes its acquisition repository", async () => {
    const fixture = await createFixture({ hangOnFetch: true });
    const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
    const controller = new AbortController();
    const acquisition = withGitHubPullRequestObjects(
      fixture.config,
      {
        base: { objectId: fixture.baseObjectId, ref: "main" },
        head: { objectId: fixture.headObjectId, ref: "review-source" },
        objectFormat: "sha1",
        projectId,
        pullRequestNumber: 42,
        repository: { name: "review-source", owner: "kestrel" },
        signal: controller.signal,
      },
      () => Promise.resolve(undefined),
    );
    await waitForFile(fixture.fetchStarted);
    controller.abort();

    await expect(acquisition).rejects.toMatchObject({ code: "acquisition_cancelled" });
    await expect(
      readdir(join(fixture.config.artifactRoot, "projects", projectId, "acquisition-repositories")),
    ).resolves.toEqual([]);
  });
});
