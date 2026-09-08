import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, it, vi } from "vitest";

import {
  loadGitHubPlanningStarter,
  loadGitHubSkillBundle,
} from "./factory-github-skill-bundles.js";
import type { runFactoryGitHubCli } from "./factory-github-cli.js";

const request = {
  owner: "owner",
  repository: "procedures",
  path: "questions/SKILL.md",
  ref: "main",
};
const commit = "a".repeat(40);
const entry =
  "---\nname: questions\ndescription: Ask about the decision.\n---\nRead [Guide](GUIDE.md).\n";
const guide = "Ask which outcome matters most.\n";
const blobId = (content: string) =>
  createHash("sha1")
    .update(`blob ${String(Buffer.byteLength(content))}\0`)
    .update(content)
    .digest("hex");

interface FixtureEntry {
  path: string;
  type: string;
  mode: string;
  sha: string;
  size?: number;
}

function fixture(
  files: Record<string, string> = {
    "questions/SKILL.md": entry,
    "questions/GUIDE.md": guide,
    "questions/PRIVATE.md": "Unrelated private content",
  },
  source = request,
  commitId = commit,
) {
  const base = `/repos/${source.owner}/${source.repository}`;
  const responses = new Map<string, unknown>([["/user", { login: "operator" }]]);
  const entries = new Map<string, FixtureEntry>();
  const buildTree = (prefix: string): string => {
    const children = [
      ...new Set(
        Object.keys(files)
          .filter((path) => path.startsWith(prefix))
          .map((path) => path.slice(prefix.length).split("/")[0]),
      ),
    ];
    const tree: FixtureEntry[] = children
      .filter((child) => child !== undefined)
      .map((path) => {
        const sourcePath = prefix + path;
        const content = files[sourcePath];
        const item: FixtureEntry =
          content === undefined
            ? { path, type: "tree", mode: "040000", sha: buildTree(sourcePath + "/") }
            : {
                path,
                type: "blob",
                mode: "100644",
                sha: blobId(content),
                size: Buffer.byteLength(content),
              };
        entries.set(sourcePath, item);
        return item;
      });
    tree.sort((left, right) => {
      const leftKey = left.path + (left.type === "tree" ? "/" : "");
      const rightKey = right.path + (right.type === "tree" ? "/" : "");
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const bytes = Buffer.concat(
      tree.flatMap((item) => [
        Buffer.from(`${item.mode === "040000" ? "40000" : item.mode} ${item.path}\0`),
        Buffer.from(item.sha, "hex"),
      ]),
    );
    const sha = createHash("sha1")
      .update(`tree ${String(bytes.length)}\0`)
      .update(bytes)
      .digest("hex");
    responses.set(`${base}/git/trees/${sha}`, { sha, truncated: false, tree });
    return sha;
  };
  const rootTree = buildTree("");
  const resolved = { sha: commitId, commit: { tree: { sha: rootTree } } };
  responses.set(`${base}/commits/${encodeURIComponent(source.ref)}`, resolved);
  for (const content of Object.values(files))
    responses.set(`${base}/git/blobs/${blobId(content)}`, {
      sha: blobId(content),
      encoding: "base64",
      size: Buffer.byteLength(content),
      content: Buffer.from(content).toString("base64"),
    });
  const run = vi.fn<typeof runFactoryGitHubCli>(({ args }) => {
    expect(args.slice(0, 3)).toEqual(["api", "--hostname", "github.com"]);
    expect(args).toContain("GET");
    const endpoint = args[3];
    if (endpoint === undefined || !responses.has(endpoint))
      throw new Error(`Unexpected provider read: ${endpoint ?? "missing endpoint"}`);
    return Promise.resolve({
      stdout: JSON.stringify(responses.get(endpoint)),
      stderr: "",
      exitCode: 0,
      started: true,
    });
  });
  return { responses, run, entries, resolved, rootTree, base };
}

it("pins one ref resolution and retains only the entry and its required Markdown", async () => {
  const provider = fixture();
  const bundle = await loadGitHubSkillBundle(request, { run: provider.run });
  expect(bundle.name).toBe("questions");
  expect(bundle.files.filter(({ path }) => path !== ".kestrel/source.json")).toEqual([
    { path: "GUIDE.md", content: guide },
    { path: "SKILL.md", content: entry },
  ]);
  expect(bundle.source).toMatchObject({
    kind: "github",
    owner: "owner",
    repository: "procedures",
    path: "questions/SKILL.md",
    requestedRef: "main",
    commitId: commit,
  });
  expect(bundle.contentDigest).toMatch(/^[a-f0-9]{64}$/u);
  const endpoints = provider.run.mock.calls.map(([input]) => input.args[3]);
  expect(endpoints.filter((endpoint) => endpoint?.includes("/commits/"))).toEqual([
    "/repos/owner/procedures/commits/main",
  ]);
  expect(endpoints).not.toContain(
    `/repos/owner/procedures/git/blobs/${blobId("Unrelated private content")}`,
  );
});

it("rejects an unresolved required named Skill before returning a selectable partial bundle", async () => {
  const provider = fixture({
    "questions/SKILL.md": entry.replace(
      "Read [Guide](GUIDE.md).",
      'Call the Skill tool with "unavailable".',
    ),
  });
  await expect(loadGitHubSkillBundle(request, { run: provider.run })).rejects.toMatchObject({
    code: "missing_dependency",
  });
});

const starterSource = {
  owner: "mattpocock",
  repository: "skills",
  path: "skills/engineering/grill-with-docs/SKILL.md",
  ref: "5c89081d4bbeb3d039a42093653f90bb698d780e",
};
const starterPaths = [
  "skills/engineering/grill-with-docs/SKILL.md",
  "skills/productivity/grilling/SKILL.md",
  "skills/engineering/domain-modeling/SKILL.md",
  "skills/engineering/domain-modeling/CONTEXT-FORMAT.md",
  "skills/engineering/domain-modeling/ADR-FORMAT.md",
  "skills/engineering/to-spec/SKILL.md",
  "skills/engineering/to-tickets/SKILL.md",
  "LICENSE",
];
async function starterFixture() {
  const files = Object.fromEntries(
    await Promise.all(
      starterPaths.map(
        async (path) =>
          [
            path,
            await readFile(
              new URL(
                `../../../tests/fixtures/planning-skills/mattpocock/${path}`,
                import.meta.url,
              ),
              "utf8",
            ),
          ] as const,
      ),
    ),
  );
  return { files, ...fixture(files, starterSource, starterSource.ref) };
}

it("retains the five actual starter procedures, their dependency closure and MIT license at one commit", async () => {
  const provider = await starterFixture();
  const bundle = await loadGitHubPlanningStarter({ run: provider.run });
  expect(bundle.name).toBe("grilling-starter");
  expect(bundle.source.commitId).toBe("5c89081d4bbeb3d039a42093653f90bb698d780e");
  for (const path of starterPaths)
    expect(bundle.files.find((file) => file.path === `sources/${path}`)?.content).toBe(
      provider.files[path],
    );
  expect(bundle.files).toHaveLength(10);
  expect(bundle.files.find(({ path }) => path === "SKILL.md")).toBeDefined();
  const manifest = bundle.files.find(({ path }) => path === ".kestrel/source.json");
  expect(JSON.parse(manifest?.content ?? "null")).toMatchObject({
    composition: {
      name: "grilling-starter",
      version: 1,
      skills: [
        { name: "grill-with-docs", dependsOn: ["grilling", "domain-modeling"] },
        { name: "grilling", dependsOn: [] },
        { name: "domain-modeling", dependsOn: [] },
        { name: "to-spec", dependsOn: [] },
        { name: "to-tickets", dependsOn: [] },
      ],
    },
  });
  expect(
    provider.run.mock.calls.filter(([input]) => input.args[3]?.includes("/commits/")),
  ).toHaveLength(1);
});

it("keeps the resolved commit when a moving ref changes, and gives the later import its own digest", async () => {
  const provider = fixture();
  const run: typeof runFactoryGitHubCli = async (input) => {
    const result = await provider.run(input);
    if (input.args[3]?.includes("/git/blobs/")) provider.resolved.sha = "f".repeat(40);
    return result;
  };
  const first = await loadGitHubSkillBundle(request, { run });
  const second = await loadGitHubSkillBundle(request, { run });
  expect(first.source.commitId).toBe("a".repeat(40));
  expect(second.source.commitId).toBe("f".repeat(40));
  expect(second.source.candidateId).toBe(first.source.candidateId);
  expect(second.files.filter(({ path }) => path !== ".kestrel/source.json")).toEqual(
    first.files.filter(({ path }) => path !== ".kestrel/source.json"),
  );
  expect(second.contentDigest).not.toBe(first.contentDigest);
  expect(first.files.find(({ path }) => path === ".kestrel/source.json")?.content).toContain(
    "a".repeat(40),
  );
});

it("retains a different requested ref even when both refs resolve to the same commit", async () => {
  const provider = fixture();
  provider.responses.set(`${provider.base}/commits/heads%2Frelease`, provider.resolved);
  const main = await loadGitHubSkillBundle(request, { run: provider.run });
  const release = await loadGitHubSkillBundle(
    { ...request, ref: "heads/release" },
    { run: provider.run },
  );
  expect(release.source.requestedRef).toBe("heads/release");
  expect(release.source.candidateId).toBe(main.source.candidateId);
  expect(release.contentDigest).not.toBe(main.contentDigest);
});

it("recursively resolves nested links and cycles while ignoring examples, external links and optional slash routes", async () => {
  const source = entry.replace(
    "Read [Guide](GUIDE.md).",
    [
      "Read [Guide](refs/Guide%20One.md#questions).",
      "See [external](https://example.invalid/PRIVATE.md).",
      "Optional: use /wizard or /prototype later.",
      "```md\nRead [example](../../PRIVATE.md).\n```",
      'Never call the Skill tool with "not-selected".',
    ].join("\n"),
  );
  const files = {
    "questions/SKILL.md": source,
    "questions/refs/Guide One.md": "Read [terms](../TERMS.md).\n",
    "questions/TERMS.md": "Use [entry](./SKILL.md).\n",
    "PRIVATE.md": "Never read this unrelated file",
  };
  const provider = fixture(files);
  const bundle = await loadGitHubSkillBundle(request, { run: provider.run });
  expect(bundle.files.map(({ path }) => path)).toEqual([
    ".kestrel/source.json",
    "SKILL.md",
    "TERMS.md",
    "refs/Guide One.md",
  ]);
  expect(
    provider.run.mock.calls.filter(([input]) => input.args[3]?.includes("/git/blobs/")),
  ).toHaveLength(3);
});

it.each([
  "../PRIVATE.md",
  "%2e%2e/PRIVATE.md",
  "/PRIVATE.md",
  "file:///PRIVATE.md",
  "C:/PRIVATE.md",
])("rejects escaping reference %s before reading its target", async (reference) => {
  const provider = fixture({
    "questions/SKILL.md": entry.replace("GUIDE.md", reference),
    "PRIVATE.md": "Outside source",
  });
  await expect(loadGitHubSkillBundle(request, { run: provider.run })).rejects.toMatchObject({
    code: "unsafe_path",
  });
  expect(
    provider.run.mock.calls.filter(([input]) => input.args[3]?.includes("/git/blobs/")),
  ).toHaveLength(1);
});

it.each([
  { path: "questions", type: "blob", mode: "120000", blobs: 0 },
  { path: "questions", type: "commit", mode: "160000", blobs: 0 },
  { path: "questions/SKILL.md", type: "blob", mode: "120000", blobs: 0 },
  { path: "questions/GUIDE.md", type: "blob", mode: "120000", blobs: 1 },
])("rejects a $mode entry at $path without following it", async ({ path, type, mode, blobs }) => {
  const provider = fixture();
  const target = provider.entries.get(path);
  if (target === undefined) throw new Error("Missing fixture entry");
  Object.assign(target, { type, mode });
  await expect(loadGitHubSkillBundle(request, { run: provider.run })).rejects.toMatchObject({
    code: "unsafe_path",
  });
  expect(
    provider.run.mock.calls.filter(([input]) => input.args[3]?.includes("/git/blobs/")),
  ).toHaveLength(blobs);
});

it("rejects a missing required Markdown reference", async () => {
  const provider = fixture({ "questions/SKILL.md": entry });
  await expect(loadGitHubSkillBundle(request, { run: provider.run })).rejects.toMatchObject({
    code: "missing_reference",
  });
});

it.each([
  "skills/engineering/domain-modeling/ADR-FORMAT.md",
  "skills/productivity/grilling/SKILL.md",
  "LICENSE",
])("does not return a partial starter when %s is missing", async (path) => {
  const { files } = await starterFixture();
  const remaining = Object.fromEntries(
    Object.entries(files).filter(([candidate]) => candidate !== path),
  );
  const provider = fixture(remaining, starterSource, starterSource.ref);
  await expect(loadGitHubPlanningStarter({ run: provider.run })).rejects.toMatchObject({
    code: "missing_reference",
  });
});

it("rejects an ambiguous starter dependency whose entry declares another name", async () => {
  const { files } = await starterFixture();
  const path = "skills/productivity/grilling/SKILL.md";
  files[path] = files[path]?.replace("name: grilling", "name: domain-modeling") ?? "";
  const provider = fixture(files, starterSource, starterSource.ref);
  await expect(loadGitHubPlanningStarter({ run: provider.run })).rejects.toMatchObject({
    code: "missing_dependency",
  });
});

it.each([
  { body: "Run `node scripts/load.js` before asking.", code: "unsupported_execution" },
  { body: "Read [config](config.json).", code: "unsupported_reference" },
  { body: "Read [source](.kestrel/source.json).", code: "unsupported_reference" },
  { body: "Call the Skill tool with a dynamically chosen name.", code: "unsupported_dependency" },
])("rejects unsupported required source: $body", async ({ body, code }) => {
  const provider = fixture({
    "questions/SKILL.md": entry.replace("Read [Guide](GUIDE.md).", body),
    "questions/scripts/load.js": "Never execute or read this script",
    "questions/config.json": "PRIVATE CONFIGURATION",
    "questions/.kestrel/source.json": "ORIGINAL MANIFEST MUST NOT BE OVERWRITTEN",
  });
  await expect(loadGitHubSkillBundle(request, { run: provider.run })).rejects.toMatchObject({
    code,
  });
  expect(
    provider.run.mock.calls.filter(([input]) => input.args[3]?.includes("/git/blobs/")),
  ).toHaveLength(1);
});

it.each([
  { path: "../questions/SKILL.md" },
  { path: "/questions/SKILL.md" },
  { path: "questions/../SKILL.md" },
  { path: "questions/README.md" },
  { owner: "https://other.invalid" },
  { repository: "../private" },
  { ref: "" },
  { ref: "main\n--other-option" },
])("rejects invalid source coordinates before provider access: %j", async (invalid) => {
  const provider = fixture();
  await expect(
    loadGitHubSkillBundle({ ...request, ...invalid }, { run: provider.run }),
  ).rejects.toMatchObject({ code: "invalid_source" });
  expect(provider.run).not.toHaveBeenCalled();
});

it("rejects malformed Skill metadata instead of silently repairing the retained source", async () => {
  const provider = fixture({
    "questions/SKILL.md": entry.replace("Ask about the decision.", "Ask: a decision"),
  });
  await expect(loadGitHubSkillBundle(request, { run: provider.run })).rejects.toMatchObject({
    code: "invalid_skill",
  });
});

it("enforces the complete byte budget including its retained source manifest", async () => {
  const base = entry.replace("Read [Guide](GUIDE.md).", "Ask a question.");
  const provider = fixture({
    "questions/SKILL.md": base + "x".repeat(128 * 1024 - Buffer.byteLength(base)),
  });
  await expect(loadGitHubSkillBundle(request, { run: provider.run })).rejects.toMatchObject({
    code: "bundle_limit",
  });
});

it("checks blob size before fetching oversized file contents", async () => {
  const provider = fixture({ "questions/SKILL.md": "x".repeat(128 * 1024 + 1) });
  await expect(loadGitHubSkillBundle(request, { run: provider.run })).rejects.toMatchObject({
    code: "bundle_limit",
  });
  expect(
    provider.run.mock.calls.filter(([input]) => input.args[3]?.includes("/git/blobs/")),
  ).toHaveLength(0);
});

it("counts the retained manifest toward the complete file limit", async () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 31; index++)
    files[`questions/ref-${String(index)}.md`] = "A reference.\n";
  files["questions/SKILL.md"] = entry.replace(
    "Read [Guide](GUIDE.md).",
    Object.keys(files)
      .map((path) => `Read [reference](${path.slice("questions/".length)}).`)
      .join("\n"),
  );
  const provider = fixture(files);
  await expect(loadGitHubSkillBundle(request, { run: provider.run })).rejects.toMatchObject({
    code: "bundle_limit",
  });
  expect(
    provider.run.mock.calls.filter(([input]) => input.args[3]?.includes("/git/blobs/")),
  ).toHaveLength(1);
});

it("rejects incomplete Git trees before fetching blobs", async () => {
  const provider = fixture();
  provider.responses.set(`${provider.base}/git/trees/${provider.rootTree}`, {
    sha: provider.rootTree,
    tree: [],
    truncated: true,
  });
  await expect(loadGitHubSkillBundle(request, { run: provider.run })).rejects.toMatchObject({
    code: "invalid_response",
  });
  expect(
    provider.run.mock.calls.filter(([input]) => input.args[3]?.includes("/git/blobs/")),
  ).toHaveLength(0);
});

it("rejects a returned commit that differs from an explicitly requested immutable SHA", async () => {
  const source = { ...request, ref: "d".repeat(40) };
  const provider = fixture(undefined, source);
  await expect(loadGitHubSkillBundle(source, { run: provider.run })).rejects.toMatchObject({
    code: "invalid_response",
  });
});

it("rejects blob bytes that disagree with the immutable tree entry", async () => {
  const provider = fixture();
  provider.responses.set(`${provider.base}/git/blobs/${blobId(entry)}`, {
    sha: blobId(entry),
    size: Buffer.byteLength(entry),
    encoding: "base64",
    content: Buffer.from(entry.replace("questions", "questione")).toString("base64"),
  });
  await expect(loadGitHubSkillBundle(request, { run: provider.run })).rejects.toMatchObject({
    code: "invalid_response",
  });
});

it("rejects non-UTF-8 source before interpreting instructions", async () => {
  const provider = fixture();
  const bytes = Buffer.from([0xff, 0xfe]);
  const sha = createHash("sha1").update("blob 2\0").update(bytes).digest("hex");
  const target = provider.entries.get("questions/SKILL.md");
  if (target === undefined) throw new Error("Missing entry fixture");
  Object.assign(target, { sha, size: 2 });
  provider.responses.set(`${provider.base}/git/blobs/${sha}`, {
    sha,
    size: 2,
    encoding: "base64",
    content: bytes.toString("base64"),
  });
  await expect(loadGitHubSkillBundle(request, { run: provider.run })).rejects.toMatchObject({
    code: "unreadable_file",
  });
});

it.each([
  { stderr: "gh auth login ghp_fixture_private", exitCode: 4, code: "needs_authentication" },
  { stderr: "gh: denied (HTTP 403) ghp_fixture_private", exitCode: 1, code: "access_denied" },
  {
    stderr: "gh: Not Found (HTTP 404) ghp_fixture_private",
    exitCode: 1,
    code: "source_unavailable",
  },
  { stderr: "API rate limit exceeded ghp_fixture_private", exitCode: 1, code: "rate_limited" },
])(
  "returns an actionable $code error without exposing provider stderr",
  async ({ stderr, exitCode, code }) => {
    const run: typeof runFactoryGitHubCli = () =>
      Promise.resolve({ stdout: "", stderr, exitCode, started: true });
    const error: unknown = await loadGitHubSkillBundle(request, { run }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("ghp_fixture_private");
  },
);

it("rejects an account change before exposing the completed import", async () => {
  const provider = fixture();
  let accounts = 0;
  const run: typeof runFactoryGitHubCli = async (input) => {
    const result = await provider.run(input);
    if (input.args[3] === "/user" && ++accounts === 2)
      return { ...result, stdout: JSON.stringify({ login: "other-account" }) };
    return result;
  };
  await expect(loadGitHubSkillBundle(request, { run })).rejects.toMatchObject({
    code: "account_changed",
  });
});

it("stops further provider reads when the import is cancelled", async () => {
  const provider = fixture();
  const controller = new AbortController();
  const run: typeof runFactoryGitHubCli = async (input) => {
    const result = await provider.run(input);
    if (input.args[3]?.includes("/commits/")) controller.abort();
    return result;
  };
  await expect(
    loadGitHubSkillBundle(request, { run, signal: controller.signal }),
  ).rejects.toMatchObject({ code: "cancelled" });
  expect(provider.run.mock.calls).toHaveLength(2);
});

it("does not reject a selected Skill because an unrelated Git filename is outside the bundle path grammar", async () => {
  const provider = fixture({
    "questions/SKILL.md": entry,
    "questions/GUIDE.md": guide,
    "questions/UNRELATED:notes.md": "Do not fetch this file",
  });
  await expect(loadGitHubSkillBundle(request, { run: provider.run })).resolves.toMatchObject({
    name: "questions",
  });
  expect(
    provider.run.mock.calls.filter(([input]) => input.args[3]?.includes("/git/blobs/")),
  ).toHaveLength(2);
});

it("sorts all retained paths before calculating the manifest-bound bundle digest", async () => {
  const provider = fixture({
    "questions/SKILL.md": entry.replace("GUIDE.md", "!GUIDE.md"),
    "questions/!GUIDE.md": guide,
  });
  const bundle = await loadGitHubSkillBundle(request, { run: provider.run });
  expect(bundle.files.map(({ path }) => path)).toEqual([
    "!GUIDE.md",
    ".kestrel/source.json",
    "SKILL.md",
  ]);
});

it("returns an actionable error if the provider transport rejects without a response", async () => {
  const run: typeof runFactoryGitHubCli = () =>
    Promise.reject(new Error("private provider detail"));
  const error: unknown = await loadGitHubSkillBundle(request, { run }).catch(
    (reason: unknown) => reason,
  );
  expect(error).toMatchObject({ code: "provider_unavailable" });
  expect(String(error)).not.toContain("private provider detail");
});

it("enforces one aggregate source budget across all starter dependencies", async () => {
  const { files } = await starterFixture();
  files["skills/productivity/grilling/SKILL.md"] =
    (files["skills/productivity/grilling/SKILL.md"] ?? "") + "\n" + "x".repeat(70_000);
  files["skills/engineering/to-spec/SKILL.md"] =
    (files["skills/engineering/to-spec/SKILL.md"] ?? "") + "\n" + "y".repeat(70_000);
  const provider = fixture(files, starterSource, starterSource.ref);
  await expect(loadGitHubPlanningStarter({ run: provider.run })).rejects.toMatchObject({
    code: "bundle_limit",
  });
});
