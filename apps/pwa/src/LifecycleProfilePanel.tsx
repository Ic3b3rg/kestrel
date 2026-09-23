import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import {
  LifecycleProfileViewSchema,
  LifecycleSettingsSchema,
  type LifecycleOverrides,
  type LifecyclePhase,
  type LifecycleProfileView,
  type LifecycleSettings,
  type PlanningSkillSummary,
} from "@kestrel/contracts";
import { ApiClientError, authenticatedMutationHeaders, requireJson } from "./api.js";
import { fetchPlanningSkillCatalog } from "./factory-skills-api.js";
import { FormFeedback } from "./components/FormFeedback.js";
import { Button } from "./components/ui/button.js";
import { Label } from "./components/ui/label.js";
import { NativeSelect } from "./components/ui/native-select.js";

const phases: { id: LifecyclePhase; label: string }[] = [
  { id: "planning", label: "Planning" },
  { id: "implementation", label: "Implementation & repair" },
  { id: "review", label: "Conceptual Review" },
  { id: "corrections", label: "Corrections" },
];
export function lifecycleProfilePath(phase: LifecyclePhase, projectId?: string) {
  return `/api/v1/${projectId === undefined ? "" : `projects/${encodeURIComponent(projectId)}/`}lifecycle-profiles/${phase}`;
}
function errorMessage(error: unknown) {
  return error instanceof ApiClientError
    ? error.details.message
    : "The lifecycle profile could not be loaded. Check the connection and retry.";
}
export async function fetchLifecycleProfile(
  phase: LifecyclePhase,
  projectId?: string,
  signal?: AbortSignal,
) {
  return requireJson(
    await fetch(lifecycleProfilePath(phase, projectId), {
      credentials: "same-origin",
      signal: signal ?? null,
    }),
    LifecycleProfileViewSchema,
    "Lifecycle profile",
  );
}

function ProfileFacts({ view }: { view: LifecycleProfileView }) {
  const profile = view.resolved;
  return (
    <div className="grid gap-2 text-sm">
      {view.blocked === null ? null : <FormFeedback kind="error">{view.blocked}</FormFeedback>}
      {profile === null ? null : (
        <>
          <p>
            {view.models.find((model) => model.id === profile.modelId)?.displayName ??
              profile.modelId}{" "}
            · Effort: {profile.effort ?? "Runtime default"} · Speed:{" "}
            {profile.serviceTier === "default"
              ? "Standard"
              : (profile.serviceTier ?? "Runtime default")}
          </p>
          {profile.inherited.length === 0 ? null : (
            <p className="text-muted-foreground">
              Uses Installation defaults for{" "}
              {profile.inherited
                .map((field) =>
                  field === "skillDigests" ? "Skills" : field === "runtimeId" ? "runtime" : field,
                )
                .join(", ")}
              .
            </p>
          )}
          {profile.skills.length === 0 ? (
            <p>No default Skills selected.</p>
          ) : (
            <ul>
              {profile.skills.map((skill) => (
                <li key={skill.contentDigest}>
                  {skill.name} ·{" "}
                  <span title={skill.contentDigest}>{skill.contentDigest.slice(0, 12)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export function LifecycleProfileSummary({
  phase,
  projectId,
  online,
}: {
  phase: LifecyclePhase;
  projectId: string;
  online: boolean;
}) {
  const [view, setView] = useState<LifecycleProfileView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    setView(null);
    setError(null);
    void fetchLifecycleProfile(phase, projectId, controller.signal)
      .then((view) => {
        if (!controller.signal.aborted) setView(view);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      });
    return () => controller.abort();
  }, [phase, projectId, online, reload]);
  return (
    <section
      className="grid gap-2 border-t py-3"
      aria-label={`${phases.find((item) => item.id === phase)?.label ?? phase} profile`}
    >
      <strong>{phases.find((item) => item.id === phase)?.label} profile</strong>
      {!online ? (
        <p>Reconnect to check the profile before starting new work.</p>
      ) : error !== null ? (
        <>
          <FormFeedback kind="error">{error}</FormFeedback>
          <Button type="button" variant="outline" onClick={() => setReload((value) => value + 1)}>
            Retry profile
          </Button>
        </>
      ) : view === null ? (
        <FormFeedback kind="pending">Checking the effective profile…</FormFeedback>
      ) : (
        <ProfileFacts view={view} />
      )}
      <a href={`/projects/${encodeURIComponent(projectId)}/settings`}>Change Lifecycle settings</a>
    </section>
  );
}

export function LifecycleProfilePanel({
  projectId,
  online,
}: {
  projectId?: string;
  online: boolean;
}) {
  const [phase, setPhase] = useState<LifecyclePhase>("planning");
  return (
    <section className="record-section grid gap-4" aria-label="Lifecycle settings">
      <h2>Lifecycle profiles</h2>
      <p>
        {projectId === undefined
          ? "Installation defaults for future work."
          : "Inherit Installation defaults or override individual fields for this Project."}{" "}
        Accepted work keeps its original profile.
      </p>
      <div className="flex flex-wrap gap-2" aria-label="Lifecycle phase">
        {phases.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant={phase === item.id ? "default" : "outline"}
            aria-pressed={phase === item.id}
            onClick={() => setPhase(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </div>
      <ProfileEditor
        key={`${projectId ?? "installation"}/${phase}`}
        phase={phase}
        online={online}
        {...(projectId === undefined ? {} : { projectId })}
      />
    </section>
  );
}

function ProfileEditor({
  phase,
  projectId,
  online,
}: {
  phase: LifecyclePhase;
  projectId?: string;
  online: boolean;
}) {
  const [view, setView] = useState<LifecycleProfileView | null>(null);
  const [draft, setDraft] = useState<LifecycleOverrides>({});
  const [skills, setSkills] = useState<PlanningSkillSummary[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [reload, setReload] = useState(0);
  const id = useId();
  const dirty = useRef(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    setError(null);
    void Promise.all([
      fetchLifecycleProfile(phase, projectId, controller.signal),
      fetchPlanningSkillCatalog(controller.signal),
    ])
      .then(([next, catalog]) => {
        if (controller.signal.aborted) return;
        setView(next);
        if (!dirty.current) setDraft(projectId === undefined ? next.defaults : next.overrides);
        setSkills(catalog.skills);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      });
    return () => controller.abort();
  }, [phase, projectId, online, reload]);
  const update = (field: keyof LifecycleSettings, value: unknown) => {
    dirty.current = true;
    setDraft((draft) => {
      const next = { ...draft, [field]: value };
      return Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined));
    });
    setSuccess(false);
    setError(null);
  };
  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (view === null || active.current !== null || !online) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(null);
    setSuccess(false);
    try {
      const next = await requireJson(
        await fetch(lifecycleProfilePath(phase, projectId), {
          method: "PUT",
          credentials: "same-origin",
          headers: authenticatedMutationHeaders(),
          signal: controller.signal,
          body: JSON.stringify({
            expectedVersion:
              projectId === undefined ? view.versions.installation : view.versions.project,
            settings: draft,
          }),
        }),
        LifecycleProfileViewSchema,
        "Lifecycle profile",
      );
      if (!controller.signal.aborted) {
        setView(next);
        setSuccess(true);
        dirty.current = false;
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (active.current === controller) {
        active.current = null;
        setPending(false);
      }
    }
  };
  if (view === null)
    return (
      <div>
        {error !== null ? (
          <>
            <FormFeedback kind="error" focus>
              {error}
            </FormFeedback>
            <Button
              type="button"
              disabled={!online}
              onClick={() => setReload((value) => value + 1)}
            >
              Retry profile
            </Button>
          </>
        ) : (
          <FormFeedback kind="pending">
            {online ? "Loading Lifecycle settings…" : "Reconnect to configure lifecycle profiles."}
          </FormFeedback>
        )}
      </div>
    );
  const effective = LifecycleSettingsSchema.parse({ ...view.defaults, ...draft });
  const model =
    effective.model.kind === "runtime_default"
      ? view.models.find((model) => model.isDefault)
      : view.models.find(
          (model) =>
            model.id === (effective.model.kind === "explicit" ? effective.model.value : ""),
        );
  return (
    <form className="grid gap-4" onSubmit={(event) => void save(event)} aria-busy={pending}>
      <Label htmlFor={`${id}-runtime`}>Agent runtime</Label>
      <NativeSelect
        id={`${id}-runtime`}
        disabled={!online || pending}
        value={draft.runtimeId ?? "inherit"}
        onChange={(event) =>
          update("runtimeId", event.target.value === "inherit" ? undefined : event.target.value)
        }
      >
        {projectId === undefined ? null : (
          <option value="inherit">Inherit Installation runtime</option>
        )}
        <option value="codex_subscription" disabled={view.models.length === 0}>
          Codex subscription{view.models.length === 0 ? " · needs connection" : ""}
        </option>
        {effective.runtimeId === "codex_subscription" ? null : (
          <option value={effective.runtimeId}>{effective.runtimeId} · unavailable</option>
        )}
      </NativeSelect>
      {(["model", "effort", "speed"] as const).map((field) => {
        const value = draft[field];
        const selected =
          value === undefined
            ? "inherit"
            : value.kind === "explicit"
              ? `value:${value.value}`
              : value.kind;
        const options =
          field === "model"
            ? view.models.map((model) => ({
                value: model.id,
                label: model.displayName + (model.isDefault ? " · suggested" : ""),
              }))
            : field === "effort"
              ? (model?.supportedReasoningEfforts ?? []).map((effort) => ({
                  value: effort.reasoningEffort,
                  label:
                    effort.reasoningEffort +
                    (effort.reasoningEffort === model?.defaultReasoningEffort
                      ? " · suggested"
                      : ""),
                }))
              : (model?.serviceTiers ?? []).map((tier) => ({ value: tier.id, label: tier.name }));
        return (
          <div key={field} className="grid gap-2">
            <Label htmlFor={`${id}-${field}`}>
              {field === "model" ? "Model" : field === "effort" ? "Reasoning effort" : "Speed"}
            </Label>
            <NativeSelect
              id={`${id}-${field}`}
              disabled={!online || pending}
              value={selected}
              onChange={(event) => {
                const value = event.target.value;
                update(
                  field,
                  value === "inherit"
                    ? undefined
                    : value.startsWith("value:")
                      ? { kind: "explicit", value: value.slice(6) }
                      : { kind: value },
                );
              }}
            >
              {projectId === undefined ? null : (
                <option value="inherit">Inherit Installation {field}</option>
              )}
              <option value="runtime_default">Runtime default</option>
              {field === "speed" ? (
                <option value="standard" disabled={model?.serviceTiers === undefined}>
                  Standard
                </option>
              ) : null}
              {value?.kind === "explicit" &&
              !options.some((option) => option.value === value.value) ? (
                <option value={selected}>{value.value} · unavailable</option>
              ) : null}
              {options.map((option) => (
                <option key={option.value} value={`value:${option.value}`}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </div>
        );
      })}
      <fieldset className="grid gap-2" disabled={!online || pending}>
        <legend>Default Skills</legend>
        {projectId === undefined ? null : (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.skillDigests === undefined}
              onChange={(event) =>
                update(
                  "skillDigests",
                  event.target.checked ? undefined : view.defaults.skillDigests,
                )
              }
            />
            Inherit Installation Skills
          </label>
        )}
        {skills.map((skill) => (
          <label className="flex items-center gap-2" key={skill.contentDigest}>
            <input
              type="checkbox"
              disabled={projectId !== undefined && draft.skillDigests === undefined}
              checked={effective.skillDigests.includes(skill.contentDigest)}
              onChange={(event) =>
                update(
                  "skillDigests",
                  event.target.checked
                    ? [...effective.skillDigests, skill.contentDigest]
                    : effective.skillDigests.filter((digest) => digest !== skill.contentDigest),
                )
              }
            />
            {skill.name} · {skill.contentDigest.slice(0, 12)}
          </label>
        ))}
        {effective.skillDigests
          .filter((digest) => !skills.some((skill) => skill.contentDigest === digest))
          .map((digest) => (
            <p key={digest}>
              Unavailable Skill {digest.slice(0, 12)}. Select installed Skills again.
            </p>
          ))}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!online || pending}>
          {pending ? "Saving profile…" : "Save profile"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!online || pending}
          onClick={() => {
            dirty.current = false;
            setReload((value) => value + 1);
          }}
        >
          Reload profile
        </Button>
      </div>
      {error === null ? null : (
        <FormFeedback kind="error" focus>
          {error}
        </FormFeedback>
      )}
      {success ? <FormFeedback kind="success">Profile saved for future work.</FormFeedback> : null}
      <ProfileFacts view={view} />
    </form>
  );
}
