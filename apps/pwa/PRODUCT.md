# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One trusted Operator managing development across several repositories on a local workstation. The
Operator wants to describe work, make product decisions, and understand results without manually
coordinating coding-agent sessions.

## Product Purpose

Carry a feature from in-product grilling and an approved plan through automated issue execution to a
conceptual review and explicitly approved merge.

## Operating Context

The workstation hosts durable execution. The browser may close while work continues. GitHub stores
new and imported issues; Kestrel owns priority, gates, and execution. Projects work concurrently,
with one active feature per Project. A feature produces one PR and one current review. Veduta is the
intended pilot repository.

## Capabilities and Constraints

Chat, project Markdown, versioned plans, four-column Kanban, human questions,
requirements-to-behavior review graphs, source evidence, verification results, selected corrections,
and explicit merge. A gate blocks only its Project's queue. Published findings are presented
immediately rather than repaired automatically. An interactive preview of generated software is
outside Factory 0.1.

## Brand Commitments

Kestrel. The Operator explicitly requests a replacement dark UI, clearer information, and a working
sidebar for Projects and chats, using shadcn/ui as the component foundation. Direct implementation
is preferred over a separate prototype or visual concept selection exercise.

## Product Principles

- Keep the next meaningful action visible.
- Explain state and blockers in ordinary language.
- Carry the approved intent through implementation and review.
- Show evidence and uncertainty honestly.
- Keep Project navigation and conversations stable across reloads and transitions.

## Accessibility & Inclusion

Keyboard-operable navigation, visible focus, labeled controls, sufficient contrast, and a usable
narrow-screen layout preserve the existing application's quality bar.
