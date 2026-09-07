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
AuthenticatedShell.projectNavigation is the integration point for Project-scoped Planning Sessions
when their real data and routes exist. Do not render placeholder chats or inactive feature actions.

Use native links for navigation and generated Button, Input, NativeSelect, Label, Textarea, Dialog,
and Tabs primitives for interactions. Preserve browser modifier clicks and history. Dialogs keep
focus contained, reject accidental dismissal during work, and restore focus on close. The PR tabs
support both click and keyboard selection.

Application layout rules live in the components CSS layer so generated utility classes retain
precedence. Keep ordinary copy focused on the next action; source identity, verification, and
connection remediation remain inspectable where they inform an actual decision. Use one content
heading, proportional spacing, visible focus, and responsive wrapping. Avoid decorative textures,
section numbers, and headings prefixed with infrastructure labels.
