# Planning Skill imports

The Operator imports and selects Skills inside Kestrel's planning composer or an existing Feature
chat. Before the first prompt, selection remains in the composer; accepting that prompt freezes the
selection together with the new Feature and first turn. A Skill supplies planning instructions; it
does not acquire the runtime authority described by those instructions. The host configuration
authorizes one absolute directory through `KESTREL_PLANNING_SKILL_ROOT`. Each direct child directory
is an import candidate. Candidate responses disclose names and opaque identities, not host paths. An
unconfigured source leaves the installed catalog and retained instructions usable.

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
runs. Pinned GitHub imports and composition of the grilling starter are tracked separately in
[issue #230](https://github.com/Ic3b3rg/kestrel/issues/230).

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

## Planning authority

The runtime receives the retained instruction/reference contents along with committed Project
Markdown. Skills can guide the grilling procedure, proposed specifications, and ordered Work Items.
Instructions to write files, open provider issues, run tools, or change authority are translated to
planning proposals. Actual publication and execution continue to require the Operator's approval of
an exact Feature Plan. Browser closure does not cancel an accepted planning turn.
