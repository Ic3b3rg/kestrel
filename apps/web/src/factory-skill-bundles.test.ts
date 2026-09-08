import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type * as FileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { enumerateHostSkillCandidates, loadHostSkillBundle } from "./factory-skill-bundles.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof FileSystem>();
  return { ...filesystem, open: vi.fn(filesystem.open), readFile: vi.fn(filesystem.readFile) };
});

let fixture: string;
let root: string;
beforeEach(async () => {
  vi.clearAllMocks();
  fixture = await mkdtemp(join(tmpdir(), "kestrel-host-skills-"));
  root = join(fixture, "authorized");
  await mkdir(root);
});

const skill = (body: string) =>
  `---\nname: ask-questions\ndescription: Ask concrete questions.\n---\n${body}\n`;

function expectOnlyEntryRead() {
  const paths = [...vi.mocked(open).mock.calls, ...vi.mocked(readFile).mock.calls].map(([path]) => {
    if (typeof path !== "string") throw new Error("Expected a filesystem pathname");
    return path;
  });
  expect(paths).toHaveLength(1);
  expect(paths[0]).toMatch(/\/questions\/SKILL\.md$/u);
}
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

it("enumerates only direct Skill candidates with stable opaque identities", async () => {
  const selected = join(root, "questions");
  await mkdir(selected);
  // Enumeration must not load or interpret even this malformed entry point.
  await writeFile(join(selected, "SKILL.md"), Buffer.from([0xff, 0xfe]));
  await mkdir(join(root, "unrelated", "nested"), { recursive: true });
  await writeFile(join(root, "unrelated", "nested", "SKILL.md"), "Not a candidate");
  await writeFile(join(root, "notes.md"), "Not a candidate");
  const outside = join(fixture, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "SKILL.md"), "OUTSIDE PRIVATE CONTENT");
  await symlink(outside, join(root, "linked"));

  const candidates = await enumerateHostSkillCandidates(root);
  expect(candidates.map(({ label }) => label)).toEqual(["questions"]);
  expect(candidates[0]?.candidateId).toMatch(/^[a-f0-9]{64}$/u);
  await writeFile(join(selected, "SKILL.md"), "Changed content");
  expect(await enumerateHostSkillCandidates(root)).toEqual(candidates);
  expect(JSON.stringify(candidates)).not.toContain(fixture);
});

it("requires an available absolute root and rejects an authorized-root symlink", async () => {
  await expect(enumerateHostSkillCandidates("relative/skills")).rejects.toMatchObject({
    code: "root_unavailable",
  });
  await expect(enumerateHostSkillCandidates(join(fixture, "missing"))).rejects.toMatchObject({
    code: "root_unavailable",
  });
  const alias = join(fixture, "alias");
  await symlink(root, alias);
  await expect(enumerateHostSkillCandidates(alias)).rejects.toMatchObject({ code: "unsafe_path" });
});

it("stops discovery when the authorized directory exceeds its bounded inventory", async () => {
  await Promise.all(
    Array.from({ length: 257 }, (_, index) => writeFile(join(root, `entry-${String(index)}`), "")),
  );
  await expect(enumerateHostSkillCandidates(root)).rejects.toMatchObject({
    code: "candidate_limit",
  });
});

async function candidate(entry: string): Promise<string> {
  await mkdir(join(root, "questions"));
  await writeFile(join(root, "questions", "SKILL.md"), entry);
  const id = (await enumerateHostSkillCandidates(root))[0]?.candidateId;
  if (id === undefined) throw new Error("Fixture Skill was not discovered");
  return id;
}

it("loads the selected Skill and its recursive Markdown references without changing their text", async () => {
  const entry =
    "---\nname: ask-questions\ndescription: |\n  Ask concrete questions.\n---\nRead [Guide](./references/QUESTIONS.md#frontier).\n";
  const guide = "Read [Vocabulary](../TERMS.md).\n";
  const terms = "A decision settles one question. See [Skill](./SKILL.md).\n";
  const id = await candidate(entry);
  await mkdir(join(root, "questions", "references"));
  await writeFile(join(root, "questions", "references", "QUESTIONS.md"), guide);
  await writeFile(join(root, "questions", "TERMS.md"), terms);
  await writeFile(join(root, "questions", "UNRELATED.md"), Buffer.from([0xff]));

  const bundle = await loadHostSkillBundle(root, id);
  const { contentDigest, ...retained } = bundle;
  expect(contentDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(retained).toEqual({
    name: "ask-questions",
    description: "Ask concrete questions.",
    files: [
      { path: "SKILL.md", content: entry },
      { path: "TERMS.md", content: terms },
      { path: "references/QUESTIONS.md", content: guide },
    ],
    source: { kind: "host", label: "questions", candidateId: id },
  });
  expect(JSON.stringify(bundle)).not.toContain(fixture);
});

it.each([
  "../OUTSIDE.md",
  "%2e%2e/OUTSIDE.md",
  "..%2fOUTSIDE.md",
  "..\\OUTSIDE.md",
  "file:///PRIVATE.md",
  "C:\\private\\PRIVATE.md",
  "C:/private/PRIVATE.md",
  "/PRIVATE.md",
])("rejects escaping reference %s before opening it", async (reference) => {
  const id = await candidate(skill(`Read [required](${reference}).`));
  await writeFile(join(root, "OUTSIDE.md"), "PRIVATE CONTENT");
  await expect(loadHostSkillBundle(root, id)).rejects.toMatchObject({ code: "unsafe_path" });
  expectOnlyEntryRead();
});

it.each(["file", "directory"])(
  "rejects a reference through a symbolic %s without opening its target",
  async (kind) => {
    const id = await candidate(skill("Read [required](references/GUIDE.md)."));
    const outside = join(fixture, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "GUIDE.md"), "PRIVATE CONTENT");
    if (kind === "directory") await symlink(outside, join(root, "questions", "references"));
    else {
      await mkdir(join(root, "questions", "references"));
      await symlink(join(outside, "GUIDE.md"), join(root, "questions", "references", "GUIDE.md"));
    }
    await expect(loadHostSkillBundle(root, id)).rejects.toMatchObject({ code: "unsafe_path" });
    expectOnlyEntryRead();
  },
);

it("rejects an entry point replaced by a symbolic link after discovery", async () => {
  const id = await candidate(skill("Ask one question."));
  const outside = join(fixture, "PRIVATE.md");
  await writeFile(outside, skill("PRIVATE CONTENT"));
  await rm(join(root, "questions", "SKILL.md"));
  await symlink(outside, join(root, "questions", "SKILL.md"));
  await expect(loadHostSkillBundle(root, id)).rejects.toMatchObject({ code: "unsafe_path" });
  expect(vi.mocked(readFile).mock.calls).toHaveLength(0);
  expect(vi.mocked(open).mock.calls).toHaveLength(0);
});

it("reports a missing required Markdown reference without returning a partial bundle", async () => {
  const id = await candidate(skill("Read [required](MISSING.md)."));
  await expect(loadHostSkillBundle(root, id)).rejects.toMatchObject({ code: "missing_reference" });
  expectOnlyEntryRead();
});

it("reports non-UTF-8 reference content without exposing host paths", async () => {
  const id = await candidate(skill("Read [required](GUIDE.md)."));
  await writeFile(join(root, "questions", "GUIDE.md"), Buffer.from([0xff, 0xfe]));
  const outcome = loadHostSkillBundle(root, id);
  await expect(outcome).rejects.toMatchObject({ code: "unreadable_file" });
  await expect(outcome).rejects.not.toThrow(fixture);
});

it("rejects a bundle beyond 32 retained files", async () => {
  const links = Array.from(
    { length: 32 },
    (_, index) => `[Guide ${String(index)}](guide-${String(index)}.md)`,
  );
  const id = await candidate(skill(links.join("\n")));
  await Promise.all(
    links.map((_, index) =>
      writeFile(join(root, "questions", `guide-${String(index)}.md`), "A question."),
    ),
  );
  await expect(loadHostSkillBundle(root, id).then(() => undefined)).rejects.toMatchObject({
    code: "bundle_limit",
  });
});

it("bounds total UTF-8 bytes including the entry point", async () => {
  const entry = skill("Read [required](GUIDE.md).");
  const id = await candidate(entry);
  const remaining = 128 * 1024 - Buffer.byteLength(entry);
  await writeFile(join(root, "questions", "GUIDE.md"), "x".repeat(remaining));
  expect((await loadHostSkillBundle(root, id)).files).toHaveLength(2);
  await writeFile(join(root, "questions", "GUIDE.md"), "x".repeat(remaining - 1) + "è");
  await expect(loadHostSkillBundle(root, id).then(() => undefined)).rejects.toMatchObject({
    code: "bundle_limit",
  });
});

it("supports titled and reference-style Markdown links with encoded filenames and anchors", async () => {
  const id = await candidate(
    skill(
      'Read [First](<./references/Question One.md#scope> "Guide"), [second][rules], and [terms][].\n\n[rules]: ./references/../RULES.md "Rules"\n[terms]: TERMS.md\n[unused]: MISSING.md',
    ),
  );
  await mkdir(join(root, "questions", "references"));
  await writeFile(
    join(root, "questions", "references", "Question One.md"),
    "Read [rules](../RULES.md) and [first](Question%20One.md).",
  );
  await writeFile(join(root, "questions", "RULES.md"), "Confirm the objective.");
  await writeFile(join(root, "questions", "TERMS.md"), "A question clarifies one decision.");
  expect((await loadHostSkillBundle(root, id)).files.map(({ path }) => path)).toEqual([
    "RULES.md",
    "SKILL.md",
    "TERMS.md",
    "references/Question One.md",
  ]);
});

it("reports missing reference-style definitions", async () => {
  const id = await candidate(skill("Read [required][missing]."));
  await expect(loadHostSkillBundle(root, id).then(() => undefined)).rejects.toMatchObject({
    code: "invalid_reference",
  });
});

it("does not follow links inside examples, unused definitions, or unrelated external and image links", async () => {
  const id = await candidate(
    skill(
      [
        "Use Project CONTEXT.md and docs/adr as supplied context.",
        "Example markup: `[example](MISSING.md)`.",
        "```markdown",
        "Read [example](../PRIVATE.md).",
        "```",
        "~~~sh",
        "sh ./scripts/example.sh",
        "~~~",
        "[Source](https://example.invalid/reference.md)",
        "![Diagram](image.png)",
        "[unused]: MISSING.md",
        "Ask the Operator about unresolved decisions.",
      ].join("\n"),
    ),
  );
  expect((await loadHostSkillBundle(root, id)).files).toHaveLength(1);
  expectOnlyEntryRead();
});

it.each([
  "Run `python scripts/questions.py` before asking a question.",
  "Before proceeding, you must execute [helper](scripts/questions.py).",
  "Run this command before answering:\n```sh\nsh scripts/questions.sh\n```",
  "Required setup: execute the local script `scripts/questions.sh`.",
  "Run `./collect-context` before asking a question.",
  "Run `git status` before asking a question.",
])("rejects required execution without opening a script: %s", async (body) => {
  const id = await candidate(skill(body));
  await mkdir(join(root, "questions", "scripts"));
  const outside = join(fixture, "PRIVATE_SCRIPT");
  await writeFile(outside, "throw new Error('MUST NOT RUN OR READ');\n");
  await symlink(outside, join(root, "questions", "scripts", "questions.py"));
  await symlink(outside, join(root, "questions", "scripts", "questions.sh"));
  await expect(loadHostSkillBundle(root, id).then(() => undefined)).rejects.toMatchObject({
    code: "unsupported_execution",
  });
  expectOnlyEntryRead();
});

it("keeps negative execution instructions and optional examples as text", async () => {
  const id = await candidate(
    skill(
      [
        "Do not run `scripts/setup.sh` or execute commands.",
        "Never execute [the helper](scripts/questions.py).",
        "Optionally run `npm test` after the approved implementation.",
        "Example verification command: `npm test`.",
        "Record Project CONTEXT.md terminology and draft concrete Work Items.",
      ].join("\n"),
    ),
  );
  expect((await loadHostSkillBundle(root, id)).files).toHaveLength(1);
  expectOnlyEntryRead();
});

it("reports a required non-Markdown reference without reading unsupported content", async () => {
  const id = await candidate(skill("Read [required rules](RULES.txt) before answering."));
  await writeFile(join(root, "questions", "RULES.txt"), "UNSUPPORTED CONTENT");
  await expect(loadHostSkillBundle(root, id).then(() => undefined)).rejects.toMatchObject({
    code: "unsupported_reference",
  });
  expectOnlyEntryRead();
});

it.each([
  "No frontmatter",
  "---\nname: missing-description\n---\nAsk questions.",
  "---\nname: invalid_name\ndescription: Questions\n---\nAsk questions.",
  "---\nname: questions\ndescription: [not, text]\n---\nAsk questions.",
  "---\nname: questions\nname: duplicate\ndescription: Questions\n---\nAsk questions.",
  "---\nname: !!js/function 'function() {}'\ndescription: Questions\n---\nAsk questions.",
  "---\nname: questions\ndescription: Questions\n---\n",
])("rejects malformed Skill metadata or an empty body: %s", async (entry) => {
  const id = await candidate(entry);
  await expect(loadHostSkillBundle(root, id).then(() => undefined)).rejects.toMatchObject({
    code: "invalid_skill",
  });
});

it("preserves BOM and CRLF bytes while reading safe YAML metadata", async () => {
  const entry =
    '\uFEFF---\r\nname: ask-questions\r\ndescription: "Questions: scope first"\r\ndisable-model-invocation: true\r\n---\r\nAsk about scope.\r\n';
  const id = await candidate(entry);
  const bundle = await loadHostSkillBundle(root, id);
  expect(bundle.description).toBe("Questions: scope first");
  expect(bundle.files).toEqual([{ path: "SKILL.md", content: entry }]);
});

it("changes the digest for retained reference edits while preserving previously loaded content", async () => {
  const id = await candidate(skill("Read [guide](GUIDE.md)."));
  await writeFile(join(root, "questions", "GUIDE.md"), "Ask about scope.");
  const before = await loadHostSkillBundle(root, id);
  await writeFile(join(root, "questions", "UNRELATED.md"), "Ignore this text.");
  expect((await loadHostSkillBundle(root, id)).contentDigest).toBe(before.contentDigest);
  await writeFile(join(root, "questions", "GUIDE.md"), "Ask about acceptance.");
  const after = await loadHostSkillBundle(root, id);
  expect(after.contentDigest).not.toBe(before.contentDigest);
  expect(after.source.candidateId).toBe(before.source.candidateId);
  expect(before.files.find(({ path }) => path === "GUIDE.md")?.content).toBe("Ask about scope.");
});

it.each(["not-a-candidate", "../../PRIVATE.md", "0".repeat(64)])(
  "never interprets an unknown candidate ID as a host path: %s",
  async (id) => {
    await candidate(skill("Ask about scope."));
    await expect(loadHostSkillBundle(root, id)).rejects.toMatchObject({
      code: "candidate_not_found",
    });
    expect(vi.mocked(open).mock.calls).toHaveLength(0);
    expect(vi.mocked(readFile).mock.calls).toHaveLength(0);
  },
);

it("refuses a file replaced by a symlink between inspection and opening", async () => {
  const id = await candidate(skill("Ask about scope."));
  const outside = join(fixture, "PRIVATE.md");
  await writeFile(outside, skill("PRIVATE CONTENT"));
  const actual = await vi.importActual<typeof FileSystem>("node:fs/promises");
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    await rm(join(root, "questions", "SKILL.md"));
    await symlink(outside, join(root, "questions", "SKILL.md"));
    return actual.open(...args);
  });
  try {
    await expect(loadHostSkillBundle(root, id)).rejects.toMatchObject({ code: "unsafe_path" });
  } finally {
    vi.mocked(open).mockReset().mockImplementation(actual.open);
  }
});
