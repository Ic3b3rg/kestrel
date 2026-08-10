# PROTOTYPE — Conceptual change view

Throwaway UI prototype for the Wayfinder ticket
[Prototype the conceptual change view](https://github.com/Ic3b3rg/kestrel/issues/7).

Question: which information architecture and Graph representation lets an
Operator understand a pull request through Change Intent, affected concepts
and flows, comments, provisional risk, evidence, and flow-relevant code without
using the raw diff as the primary view?

The same simulated change is presented in three structurally different source
variants plus the Operator-approved synthesis, switchable with `?variant=A`,
`?variant=B`, `?variant=C`, and `?variant=D`.

Variant D combines A's complete narrative information architecture with B's
Graph-centered interaction. C contributes only its claim-to-evidence-to-code
trace inside node details.

## Run

From the repository root:

```sh
python3 -m http.server 4173 --directory prototype/conceptual-change-view
```

Then open <http://127.0.0.1:4173/?variant=A>.

This code is deliberately disposable. It has no backend, persistence, real
provider data, or production error handling.
