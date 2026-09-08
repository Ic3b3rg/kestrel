/** One explicitly selected, reviewed upstream procedure; this is not a dependency registry. */
export const GRILLING_STARTER = {
  name: "grilling-starter",
  description:
    "Grill requirements with Project documents, then draft a specification and ordered Work Items.",
  version: 1,
  source: {
    owner: "mattpocock",
    repository: "skills",
    path: "skills/engineering/grill-with-docs/SKILL.md",
    ref: "5c89081d4bbeb3d039a42093653f90bb698d780e",
  },
  skills: [
    {
      name: "grill-with-docs",
      path: "skills/engineering/grill-with-docs/SKILL.md",
      dependsOn: ["grilling", "domain-modeling"],
    },
    { name: "grilling", path: "skills/productivity/grilling/SKILL.md", dependsOn: [] },
    { name: "domain-modeling", path: "skills/engineering/domain-modeling/SKILL.md", dependsOn: [] },
    { name: "to-spec", path: "skills/engineering/to-spec/SKILL.md", dependsOn: [] },
    { name: "to-tickets", path: "skills/engineering/to-tickets/SKILL.md", dependsOn: [] },
  ],
} as const;

/** Kept separately from the unmodified upstream text and included in the retained bundle digest. */
export const GRILLING_STARTER_ADAPTATION = `---
name: grilling-starter
description: Grill requirements with Project documents, then draft a specification and ordered Work Items.
disable-model-invocation: true
---

# Kestrel grilling starter

Kestrel adaptation, version 1. The original procedures are by Matt Pocock, from mattpocock/skills at commit 5c89081d4bbeb3d039a42093653f90bb698d780e. Their unchanged text and MIT license are retained under sources/. The source manifest records every member and dependency. This adaptation is authored by Kestrel, separately from those original procedures.

## Interview phase

During planning chat, apply grill-with-docs together with its named grilling and domain-modeling dependencies. Use the supplied Project Markdown, glossary, ADRs and the retained CONTEXT-FORMAT.md and ADR-FORMAT.md references. Follow grilling's rounds and decision prerequisites; distinguish agreed decisions from unresolved questions. Only these interview procedures are active during this phase. The later to-spec instruction to stop interviewing does not apply yet.

A named Skill-tool call means to consult that retained member's instructions in this bundle. It does not request an actual tool call or install another Skill. The explicit dependency closure is already supplied. Optional mentions of setup, implementation, prototypes or other slash routes do not activate them.

Use facts available in the supplied Project context. Kestrel has already supplied its Project/tracker, Work Item and document conventions; do not run setup-matt-pocock-skills. If source code, full issue comments, an ADR directory inventory or another fact is absent, identify the unresolved gap. Do not claim to have inspected code, dispatched a subagent or run verification. A Skill cannot expand the available tools or sources.

## Specification and Work Item phase

Only when the Operator explicitly requests draft generation through Kestrel, apply to-spec and then to-tickets to the agreed conversation. If consequential decisions or exact verification remain unresolved, surface that gap rather than inventing an answer. Produce the existing Kestrel Feature Plan shape with acceptance outcomes, ordered Work Items, blocking dependencies and concrete verification commands. The resulting version is a draft for the Operator to review and revise.

Upstream instructions to publish specifications or tickets, add labels, or create native blocking links become proposed Work Items. Agreement with the interview or ticket breakdown is not execution approval. Provider publication and eligible work remain governed by the later explicit approval of an exact Feature Plan version.

## Proposed Project documents

Upstream glossary and ADR writes become proposed Markdown Feature artifacts, visible in chat and the plan. Follow the retained format references and cite the supplied Project context. Keep proposed content distinct from committed documents. A new ADR number is provisional unless the supplied context establishes the complete existing numbering. Applying the proposals belongs in the approved Work Items.

Planning remains read-only: do not write files, execute commands or scripts, install packages, call external providers, or delegate tool access. Preserve Kestrel's exact-version approval boundary even when an upstream procedure instructs publication or implementation.
`;
