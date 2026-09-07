# Kestrel workspace design

Mode: Operate. Factory 0.1 replaces the former light visual system with a quiet dark workspace. The
product contract is PRODUCT.md and docs/factory-v01/spec.md.

Use the generated shadcn/ui Radix nova components in src/components/ui and its neutral theme. The
application uses Tailwind v4 through the Vite plugin; components.json records the registry
configuration. Geist Variable is bundled locally. Dark surfaces, readable neutral text, subtle
borders, and restrained green/amber/red status colors carry the hierarchy. Body copy and controls
use the same sans-serif family; monospace is reserved for code and object identifiers.

The desktop sidebar is fixed at the viewport height. Projects scroll independently; Settings and
account state stay at the bottom. The current page uses aria-current; the selected Project remains
identified when Settings is open. Mobile uses the shadcn Sheet with labeled open/close controls.
AuthenticatedShell.projectNavigation contains the selected Project's real Planning Sessions and a
New feature dialog. Each feature has a stable URL, and Project links resume the last server-verified
feature. Browser storage holds only these navigation identities and clears them on sign out.

Planning keeps the feature name and Project visible above a readable conversation. Queued, running,
question, stopped, and failed turns show their saved state and an explicit next action. A failed
request retains its identity for a safe retry; closing the page does not stop accepted workstation
work. Project documents opens an inspector for the committed Markdown used by the conversation.
Chat, Plan, and Board use native links inside shadcn Tabs and keep their selection in the URL.

Plan shows the complete objective, scope, acceptance outcomes, ordered Work Items, dependencies,
verification commands, and execution limits before approval. Ordinary labeled fields create a new
version; approval names the exact saved version displayed. Switching tabs retains unsaved edits, and
leaving the feature asks before discarding them. Historical versions, generated Markdown, and the
version's frozen source documents remain inspectable. Generation shows its durable state and
explicit retry or stop controls. Board displays four real columns and opens card details with
criteria, dependencies, blocking reasons, and activity. Until execution exists, queued cards state
that execution is unavailable. Do not render placeholder Review or execution controls.

Use native links for navigation and generated Button, Input, NativeSelect, Label, Textarea, Dialog,
and Tabs primitives for interactions. Preserve browser modifier clicks and history. Dialogs keep
focus contained, reject accidental dismissal during work, and restore focus on close. The PR tabs
support both click and keyboard selection.

Application layout rules live in the components CSS layer so generated utility classes retain
precedence. Keep ordinary copy focused on the next action; source identity, verification, and
connection remediation remain inspectable where they inform an actual decision. Use one content
heading, proportional spacing, visible focus, and responsive wrapping. Avoid decorative textures,
section numbers, and headings prefixed with infrastructure labels.
