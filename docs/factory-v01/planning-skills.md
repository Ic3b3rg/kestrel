# Planning Skill imports

The Operator imports and selects Skills inside Kestrel's planning composer or an existing Feature
chat. Before the first prompt, selection remains in the composer; accepting that prompt freezes the
selection together with the new Feature and first turn. A Skill supplies planning instructions; it
does not acquire the runtime authority described by those instructions. **Skills → Import from
GitHub** offers the grilling starter or an explicit repository, Markdown entry path and ref. An
optional host configuration also authorizes one absolute directory through
`KESTREL_PLANNING_SKILL_ROOT`; each direct child directory is an import candidate. Candidate
responses disclose names and opaque identities, not host paths. An unconfigured host directory
leaves GitHub imports, the installed catalog and retained instructions usable.

## Import contract

A candidate must contain a nonempty `SKILL.md` with YAML frontmatter specifying `name` and
`description`. Names use lowercase letters, digits, and single separating hyphens, up to 64
characters. Metadata is parsed as YAML; it is never evaluated.

The import retains the entry point and the transitive closure of supported local Markdown links.
Inline Markdown links and single-line reference definitions may use relative paths, encoded names,
anchors, or titles. Cycles retain each file once. Missing required references, escapes, symlinks,
unsupported local execution, invalid metadata, and oversized bundles reject the whole import.
External links are not fetched. Example code, image references, and unused link definitions do not
introduce executable dependencies. HTML links, multiline reference definitions, complex nested link
syntax, and prose-only file dependencies are outside this first import format.

The maximums are 256 discovered candidates, 200 installed names, 32 files and 128 KiB of UTF-8 text
per bundle. Each bundle's digest covers its sorted retained file paths and contents. Catalog updates
for a name must come from the same candidate. No install hook, setup command, or bundled script
runs.

## Pinned GitHub imports

Preview resolves the requested ref once and reads the required Git trees and blobs at that full
commit through the host's GitHub CLI connection. It verifies their object identities, rejects
symlinks/submodules and retains the complete bundle before returning it. Preview is inspectable but
does not install or select the Skill. **Install this version** accepts the displayed digest and a
durable request identity without rereading the provider. Closing and reopening the import dialog
retains an uncertain install's request, so Retry cannot silently install a different version.

The source manifest, original paths and bytes, full commit, required members, license and any
Kestrel adaptation are included in the bundle digest. Advancing a branch cannot change retained
instructions. A missing required reference or unreadable source rejects the whole preview. Updating
the catalog requires another explicit preview and installation; existing turns and plans keep their
old digests. An old install retry returns its original result without rolling back the current
catalog.

The built-in grilling starter pins
[`mattpocock/skills` at `5c89081d4bbeb3d039a42093653f90bb698d780e`](https://github.com/mattpocock/skills/tree/5c89081d4bbeb3d039a42093653f90bb698d780e).
It includes `grill-with-docs`, `grilling`, `domain-modeling`, `to-spec`, `to-tickets`, both document
format references and the MIT license. Original upstream files remain unchanged under `sources/`;
the entry point separately identifies Kestrel's adaptation. Interviewing applies the first three
procedures. Explicit plan generation applies the specification and ticket procedures to the agreed
conversation. The adaptation makes the available context and phase boundaries explicit; it does not
pretend to run upstream setup, publication, repository writes or delegated tools.

## Selection and retained evidence

A Feature has a versioned selection with at most eight distinct Skill names and 256 KiB of retained
bundle JSON. Selection and message acceptance lock the same Feature. Sending from a stale selection
fails explicitly; accepting a message atomically freezes its Skill digests and queues its turn.
`$name` and `/name` select an installed Skill by name. An explicitly selected older version wins
over a newer catalog version with the same name. Unknown names reject the message without partially
selecting other names.

Import and selection commands have durable request identities. Retrying an uncertain command returns
its original accepted result, including when files or the current selection changed later. Each
planning retry copies the original turn's Skill snapshot. A selection change or replay with
different instructions starts a fresh runtime thread so prior instructions do not silently persist.

Plan generation records the accepted generation turn's retained Skills in its source context and
plan/spec Markdown. Operator revisions preserve that provenance; approval freezes the version.
Historical Skill previews load retained files by digest rather than rereading the workstation. The
database runtime can append versions and history but cannot rewrite or delete them.

## Proposed Project documents

Glossary and ADR proposals appear as draft Markdown during the interview. Explicit plan generation
then records structured proposals with their path, provisional-path flag and owning Work Item. The
plan permits at most four proposals and 32,000 combined UTF-8 Markdown bytes within its existing
96,000-byte serialized budget. Unknown owners, duplicate paths, traversal and reserved Git/Kestrel
paths are rejected. A new ADR number remains provisional when the supplied context cannot establish
the existing numbering.

**Inspect plan N documents** in the generated chat reply reads that exact retained version,
including its supplied Project and Skill sources. **Proposed documents** on the Plan tab shows the
displayed version. The Operator can revise or remove proposals in a new draft. Later drafts and
catalog updates cannot replace a historical reply's documents or provenance. Legacy plans without
proposals remain readable and retain their original JSON and Markdown.

Approval freezes the proposals with the rest of the plan. Execution receives only the claimed Work
Item's owned proposals from that approved version. Planning and approval do not write Project
documents, and a proposal does not create an extra issue outside the approved Work Items.

## Planning authority

The runtime receives the retained instruction/reference contents along with committed Project
Markdown. Skills can guide the grilling procedure, proposed specifications, and ordered Work Items.
Instructions to write files, open provider issues, run tools, or change authority are translated to
planning proposals. Actual publication and execution continue to require the Operator's approval of
an exact Feature Plan. Browser closure does not cancel an accepted planning turn.
