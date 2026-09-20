# Domain Docs

How the engineering skills should consume this repository's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repository root.
- **`CONTEXT-MAP.md`** at the repository root if it exists; it points at one `CONTEXT.md` per context.
- **`docs/adr/`** for architectural decisions relevant to the area being changed.

If any of these files do not exist, proceed silently. The `/domain-modeling` skill creates them lazily when terms or decisions are actually resolved.

## File structure

This repository uses a single domain context:

```text
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-example-decision.md
│   └── 0002-example-decision.md
└── src/
```

If the product later becomes a multi-context repository, introduce `CONTEXT-MAP.md` at the root and point it at each context-specific `CONTEXT.md`.

## Use the glossary's vocabulary

When output names a domain concept in an issue title, design proposal, hypothesis, or test, use the term defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If a needed concept is absent, either reconsider whether the project uses it or note the gap for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface the conflict explicitly instead of silently overriding it.
