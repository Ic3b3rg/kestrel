# Persistent issue board and direct development

Approved by the Operator on 2026-09-24 in conversation; no tracker issue is required.

The Project board retains GitHub observations durably. Returning to it shows saved cards
immediately; observations older than 60 seconds refresh in the background. Refresh failures
preserve content and its last successful timestamp. Local execution updates never blank cards
or empty-state text. Concurrent reads share provider work and throttling deadlines are honored.

Cards show labels and comment counts and open a read-only in-app issue view with description,
comments and a secondary GitHub link. Long conversations are paginated without silently dropping
content. Provider text is untrusted Markdown and never executable HTML.

Dragging an eligible open issue from To do to In progress is explicit development authorization,
without another approval dialog. A keyboard/touch Start action has the same semantics. The required
label is configured per Project and defaults to `ready-for-agent`. Other issues remain readable.
The command is durable and idempotent; the server enforces eligibility and prevents duplicate work.

Requests queue per Project. At the head of the queue Kestrel reads the current issue conversation,
retains it as execution evidence, derives the operational plan under the recorded authorization,
and executes through its existing bounded workflow. Missing consequential decisions remain visible
as a request for input; provider failure never becomes permission to execute stale context.
The host owns GitHub credentials; isolated execution receives the retained content, not credentials.
GitHub is the only implemented tracker. Other trackers and parallel implementations are future work.

The next issue may begin once the preceding Feature enters In review, without waiting for merge.
There remains at most one writable implementation per Project. Multiple independent Feature branches
may await review. Completed still means confirmed merge; cards cannot be manually marked reviewed
or completed. Existing plan-based entry points continue to work.

UI acceptance: Project sidebar -> board -> read issue -> close -> drag/Start -> In progress with
queued/preparing/running state -> In review -> next queued issue begins. Errors preserve cards and
explain retry. Tab/Enter provide the same actions; on narrow screens columns stack and details fit
the viewport. Internal plan versions, job identities and storage vocabulary stay out of primary copy.

Verification boundaries: GitHub adapter responses, durable board/start APIs, scheduler transitions,
PWA interactions, and one isolated browser journey. Shared runtime and other worktrees are not test
fixtures. Review compares against origin/master at `1c55791` and this specification.
