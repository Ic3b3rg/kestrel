# Veduta pilot profile

This profile was derived read-only from `/Users/silvioceccarini/Projects/veduta` and its GitHub
tracker on 2026-09-20. It onboards Veduta as a Kestrel Project and records the selected pilot
without claiming, publishing, or implementing it.

## Repository contract

| Setting                    | Veduta value                                                                    |
| -------------------------- | ------------------------------------------------------------------------------- |
| Package manager            | `pnpm@10.28.0`                                                                  |
| Node runtime               | `>=24.11.1 <25`                                                                 |
| Install                    | `pnpm install`                                                                  |
| Development start          | `pnpm dev`                                                                      |
| Standard verification      | `pnpm check`                                                                    |
| Standard check contents    | lint, format check, typecheck, unit tests, and production build                 |
| Browser suite              | Playwright in `packages/e2e`, configured by `packages/e2e/playwright.config.ts` |
| Production-like local path | `pnpm local-vps`                                                                |

## Selected pilot

[Veduta #35 — Seed fallback Surfaces only into existing Spaces](https://github.com/Ic3b3rg/veduta/issues/35)
is open, unassigned, labelled `ready-for-agent`, has no declared blocker, and has no open pull
request at the time of this check. Its committed specification is
`issues/035-store-seed-space-mismatch.md` at Veduta revision
`b7ef1c4a4fd8b9740aa2af2759413c41ff8565e5`.

The visible outcome is that Veduta can start when an installation already contains a Space but has
no persisted Surface state. Existing Spaces and rebuildable Surface files remain authoritative; a
completely empty installation retains its current first-run seed. The plan must cover empty,
partially seeded, restored, and ordinary roots, then run the focused daemon Vitest file and the
repository-wide `pnpm check`. Browser coverage is needed only if implementation changes the Home
surface rather than fixing the Store boundary.

## Kestrel onboarding

1. Start Kestrel with `npm run dev` and authorize the parent repository root from the trusted host
   if it is not already present.
2. Select Veduta through **Open Project**. Confirm that Kestrel reports the committed default branch
   and the expected GitHub repository before starting a Feature.
3. In the Feature plan, use `pnpm check` as the cumulative standard verification. Add the separate
   Playwright command from `packages/e2e` when the selected behavior has a browser surface.
4. Keep installation or any network-dependent setup outside the isolated execution attempt unless
   dependencies are already available in the prepared execution image. A missing toolchain or
   dependency must become a visible Human Gate.
5. Recheck issue #35 and the repository's open PRs immediately before planning. Approving its plan
   authorizes only the outcomes and limits recorded above; this profile does not itself claim or
   modify the issue.

The pilot should preserve Veduta's working tree exactly. Kestrel reads committed planning documents
and creates its own Feature workspace; dirty, staged, ignored, and untracked Operator bytes are not
planning input and are never reset for execution.
