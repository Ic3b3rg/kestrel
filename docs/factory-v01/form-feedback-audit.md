# Form feedback audit

Scope: source onboarding, Project setup, provider and lifecycle settings, Skills, reviews, and
Factory actions (#267–#268).

`FormFeedback` owns local pending, error, and success feedback. Errors requiring correction receive
focus. Inputs remain available after a rejected or uncertain command; the existing command identity
is reused when reconciling an uncertain durable request. A command guard prevents duplicate
submission before React renders the disabled button. Authentication expiry still returns control to
the sign-in boundary.

| Entry point / form family                                  | Local feedback and recovery                                                                                                                    | Success evidence                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Open Project, Local folder, Git URL clone / fetch          | Chooser cancellation, preview, explicit authorization, bounded operation, retry; repository selection and URL retained                         | Refreshed authorized inventory; selected Project                 |
| Local revision, observed revision, Change Intent           | Required fields, pending action, focused failure; selected references and text retained                                                        | Retained revision / saved intent                                 |
| Direct API profile, host GitHub, Codex subscription        | Validation or connection check remains in its panel; authentication, usage, unavailable and offline states stay distinct                       | Saved configuration / refreshed connection facts                 |
| Lifecycle profiles                                         | Dynamic capabilities and installed Skills, per-field inheritance, stale selection removal, optimistic-version conflict, preserved failed draft | Saved phase profile and resolved preview                         |
| Skill preview / install / remove                           | Preview and install are separate actions, local failures, retained exact version, safe retry                                                   | Installed library and selected Skill chips                       |
| Review preparation / start                                 | Exact preparation, local pending and start error independent of background reads; same request on retry                                        | Durable accepted review and retained profile                     |
| New plan, chat, plan generation / save / approval / cancel | Profile readiness before fresh authorization; pending and focused error beside action; durable identity and unsent draft retained              | Conversation turn, saved plan version, approval, or cancellation |
| Issue import / refresh / publication retry                 | Scoped pending and errors, bounded provider reads, no implicit import or execution                                                             | Imported snapshot / provider issue record                        |
| Gate answer, correction, execution stop, PR retry, merge   | Local validation and action result; duplicate guards, explicit authority and reconciliation                                                    | Durable gate, correction, run, publication or merge state        |
| Public PR open / host refresh                              | Caller awaits completion; local error or completion in the initiating panel                                                                    | Updated PR detail                                                |

The shell no longer announces every action across routes. Quiet board polling retains existing cards
and does not announce background refresh. Visible navigation, catalog/inventory loading,
connection/offline status, durable run progress, published review results and evidence inspectors
are **non-form live state**: their own status/error regions remain appropriate. They do not replace
the local outcome of a submitted command. Background reads cannot clear review-start, correction,
publication-retry or merge command errors.

Verification combines focused component tests (including synchronous duplicate submits, stale Skill
replacement, profile readiness and failed PR opens), authenticated API/database tests, and real
browser journeys for keyboard use, narrow viewports, accessibility, reload, lost responses, retry
and provider failures. Runtime/provider happy paths are verified separately from deterministic
recovery fixtures. Test reports identify which boundary is controlled.
