import { useEffect, useRef, useState } from "react";
import { BookOpen } from "lucide-react";
import type {
  FeaturePlanningSkills,
  InstallPlanningSkillCommand,
  PlanningSkillBundle,
  PlanningSkillSummary,
  SelectPlanningSkillsCommand,
} from "@kestrel/contracts";
import { Button } from "./components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog.js";
import { Label } from "./components/ui/label.js";
import { NativeSelect } from "./components/ui/native-select.js";
import { planningRequestError } from "./FeatureNavigation.js";
import {
  fetchPlanningSkill,
  fetchPlanningSkillCandidates,
  fetchPlanningSkillCatalog,
  importPlanningSkill,
  selectPlanningSkills,
} from "./factory-skills-api.js";

function SkillContents({ bundle }: { bundle: PlanningSkillBundle }) {
  const [path, setPath] = useState("SKILL.md");
  const file = bundle.files.find((entry) => entry.path === path) ?? bundle.files[0];
  return (
    <div className="grid min-w-0 gap-4">
      <div>
        <h3 className="font-medium">${bundle.name}</h3>
        <p className="text-sm text-muted-foreground">{bundle.description}</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Imported from {bundle.source.label} · retained version{" "}
        <code title={bundle.contentDigest}>{bundle.contentDigest.slice(0, 12)}</code>
      </p>
      <Label htmlFor="skill-reference">Instructions and references</Label>
      <NativeSelect
        id="skill-reference"
        value={file?.path ?? "SKILL.md"}
        onChange={(event) => setPath(event.currentTarget.value)}
      >
        {bundle.files.map((entry) => (
          <option key={entry.path} value={entry.path}>
            {entry.path}
          </option>
        ))}
      </NativeSelect>
      <pre
        aria-label="Retained Skill instructions"
        className="max-h-[45dvh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-4 text-sm leading-relaxed"
      >
        {file?.content}
      </pre>
      <p className="text-xs text-muted-foreground">
        Kestrel uses these procedures for planning. Proposed documents and issues stay in the plan
        until you approve it.
      </p>
    </div>
  );
}

const ignoreAuthenticationError = () => false;
export function SkillProvenance({
  skills,
  onAuthenticationError = ignoreAuthenticationError,
}: {
  skills: PlanningSkillSummary[];
  onAuthenticationError?: (error: unknown) => boolean;
}) {
  const [preview, setPreview] = useState<PlanningSkillBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  useEffect(() => {
    if (digest === null) return;
    const controller = new AbortController();
    setPreview(null);
    setError(null);
    void fetchPlanningSkill(digest, controller.signal)
      .then((bundle) => {
        if (!controller.signal.aborted) setPreview(bundle);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && !onAuthenticationError(failure))
          setError(planningRequestError(failure, "The retained Skill could not be loaded."));
      });
    return () => controller.abort();
  }, [digest, onAuthenticationError]);
  if (skills.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 text-xs" aria-label="Skills used for this artifact">
      {skills.map((skill) => (
        <Button
          key={skill.contentDigest}
          size="sm"
          variant="ghost"
          onClick={() => setDigest(skill.contentDigest)}
        >
          Used ${skill.name} · {skill.contentDigest.slice(0, 8)}
        </Button>
      ))}
      <Dialog
        open={digest !== null}
        onOpenChange={(value) => {
          if (!value) setDigest(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
          <DialogTitle>Skill used for this artifact</DialogTitle>
          <DialogDescription>
            The retained instructions remain available when the catalog changes.
          </DialogDescription>
          {error === null ? (
            preview === null ? (
              <p role="status">Loading instructions…</p>
            ) : (
              <SkillContents bundle={preview} />
            )
          ) : (
            <p role="alert">{error}</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

type Attempt =
  | { kind: "import"; command: InstallPlanningSkillCommand }
  | { kind: "select"; command: SelectPlanningSkillsCommand };
interface PlanningSkillsCommonProps {
  projectId: string;
  online: boolean;
  editable: boolean;
  selection: FeaturePlanningSkills;
  onAuthenticationError: (error: unknown) => boolean;
}
export type PlanningSkillsPanelProps = PlanningSkillsCommonProps &
  (
    | { featureId: string; onChanged: () => void; onDraftSelection?: never }
    | {
        featureId?: never;
        onChanged?: never;
        onDraftSelection: (skills: PlanningSkillSummary[]) => void;
      }
  );
export function PlanningSkillsPanel({
  projectId,
  featureId,
  online,
  editable,
  selection,
  onChanged,
  onDraftSelection,
  onAuthenticationError,
}: PlanningSkillsPanelProps) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<PlanningSkillSummary[]>([]);
  const [candidates, setCandidates] = useState<Array<{ candidateId: string; label: string }>>([]);
  const [configured, setConfigured] = useState(false);
  const [candidate, setCandidate] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<PlanningSkillBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const submitting = useRef(false);
  const alive = useRef(true);
  const previewRequest = useRef<AbortController | null>(null);
  const selectionDigests = selection.skills.map((skill) => skill.contentDigest).join(",");
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => () => previewRequest.current?.abort(), [open]);
  useEffect(() => {
    if (!open || !online) return;
    const controller = new AbortController();
    setLoading(true);
    setSelected(selectionDigests === "" ? [] : selectionDigests.split(","));
    void Promise.all([
      fetchPlanningSkillCatalog(controller.signal),
      fetchPlanningSkillCandidates(controller.signal),
    ])
      .then(([installed, source]) => {
        if (!controller.signal.aborted) {
          setCatalog(installed.skills);
          setCandidates(source.candidates);
          setConfigured(source.configured);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && !onAuthenticationError(failure))
          setError(
            planningRequestError(
              failure,
              "Skills could not be loaded. Reopen this panel to retry.",
            ),
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, online, selection.version, selectionDigests, onAuthenticationError]);
  const inspect = (digest: string) => {
    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    setError(null);
    void fetchPlanningSkill(digest, controller.signal)
      .then((bundle) => {
        if (!controller.signal.aborted) setPreview(bundle);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && !onAuthenticationError(failure))
          setError(planningRequestError(failure, "The Skill preview could not be loaded."));
      });
  };
  const run = async (next?: Attempt) => {
    if (!online || submitting.current) return;
    if (next !== undefined) attempt.current = next;
    const current = attempt.current;
    if (current === null) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      if (current.kind === "import") {
        const bundle = await importPlanningSkill(current.command);
        const installed = await fetchPlanningSkillCatalog();
        if (alive.current) {
          setCatalog(installed.skills);
          setPreview(bundle);
        }
      } else {
        if (onDraftSelection !== undefined) {
          const skills = current.command.digests.map((digest) =>
            available.find((skill) => skill.contentDigest === digest),
          );
          if (skills.some((skill) => skill === undefined))
            throw new Error("The selected Skill is unavailable");
          onDraftSelection(skills.filter((skill) => skill !== undefined));
        } else {
          await selectPlanningSkills(projectId, featureId, current.command);
        }
        if (alive.current) {
          onChanged?.();
          setOpen(false);
        }
      }
      attempt.current = null;
    } catch (failure) {
      if (alive.current && !onAuthenticationError(failure))
        setError(
          planningRequestError(
            failure,
            "Kestrel could not confirm this request. Retry to check the same request safely.",
          ),
        );
    } finally {
      submitting.current = false;
      if (alive.current) setPending(false);
    }
  };
  const available = [
    ...catalog,
    ...selection.skills.filter(
      (skill) => !catalog.some((item) => item.contentDigest === skill.contentDigest),
    ),
  ];
  return (
    <>
      <Button
        variant="outline"
        disabled={!online}
        onClick={() => {
          setPreview(null);
          setOpen(true);
        }}
      >
        <BookOpen aria-hidden="true" />
        Skills{selection.skills.length === 0 ? "" : ` (${String(selection.skills.length)})`}
      </Button>
      <Dialog
        open={open && online}
        onOpenChange={(value) => {
          if (!pending) setOpen(value);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
          <DialogTitle>Planning Skills</DialogTitle>
          <DialogDescription>
            Choose the procedures that guide this conversation. Inspect their instructions before
            using them.
          </DialogDescription>
          {error === null ? null : (
            <div role="alert" className="grid gap-2 text-sm">
              <p>{error}</p>
              {attempt.current === null ? null : (
                <Button variant="outline" disabled={pending} onClick={() => void run()}>
                  {attempt.current.kind === "import" ? "Retry import" : "Retry selection"}
                </Button>
              )}
            </div>
          )}
          {preview === null ? (
            <>
              {loading ? (
                <p role="status">Loading Skills…</p>
              ) : (
                <div className="grid gap-4">
                  <div className="grid gap-2">
                    {available.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        Import a Skill below to give your planning chat a procedure to follow.
                      </p>
                    ) : (
                      available.map((skill) => (
                        <div
                          key={skill.contentDigest}
                          className="flex items-start gap-3 rounded-md border p-3"
                        >
                          <input
                            type="checkbox"
                            className="mt-1 size-4 accent-primary"
                            aria-label={`Use $${skill.name}${available.filter((item) => item.name === skill.name).length > 1 ? ` version ${skill.contentDigest.slice(0, 8)}` : ""}`}
                            checked={selected.includes(skill.contentDigest)}
                            disabled={!editable || pending || attempt.current !== null}
                            onChange={(event) => {
                              const checked = event.currentTarget.checked;
                              setSelected((current) =>
                                checked
                                  ? [
                                      ...current.filter(
                                        (digest) =>
                                          !available.some(
                                            (item) =>
                                              item.name === skill.name &&
                                              item.contentDigest === digest,
                                          ),
                                      ),
                                      skill.contentDigest,
                                    ]
                                  : current.filter((digest) => digest !== skill.contentDigest),
                              );
                            }}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="font-medium">${skill.name}</p>
                            <p className="text-sm text-muted-foreground">{skill.description}</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {skill.source.label} · {skill.contentDigest.slice(0, 8)}
                              {catalog.some((item) => item.contentDigest === skill.contentDigest)
                                ? ""
                                : " · retained selection"}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending}
                            onClick={() => inspect(skill.contentDigest)}
                          >
                            Inspect ${skill.name}
                          </Button>
                        </div>
                      ))
                    )}
                    {!editable ? (
                      <p className="text-sm text-muted-foreground">
                        Skills can be changed while planning, after the current reply finishes.
                      </p>
                    ) : null}
                    <Button
                      disabled={
                        !editable || pending || attempt.current !== null || selected.length > 8
                      }
                      onClick={() =>
                        void run({
                          kind: "select",
                          command: {
                            requestId: crypto.randomUUID(),
                            expectedVersion: selection.version,
                            digests: selected,
                          },
                        })
                      }
                    >
                      Use selected Skills
                    </Button>
                  </div>
                  <div className="grid gap-3 border-t pt-4">
                    <h3 className="font-medium">Import from the workstation</h3>
                    {configured ? (
                      <>
                        <Label htmlFor="host-skill-candidate">Available Skills</Label>
                        <NativeSelect
                          id="host-skill-candidate"
                          aria-label="Host Skill to import"
                          value={candidate}
                          disabled={pending || attempt.current !== null}
                          onChange={(event) => setCandidate(event.currentTarget.value)}
                        >
                          <option value="">Choose a Skill</option>
                          {candidates.map((item) => (
                            <option key={item.candidateId} value={item.candidateId}>
                              {item.label}
                            </option>
                          ))}
                        </NativeSelect>
                        <Button
                          variant="outline"
                          disabled={candidate === "" || pending || attempt.current !== null}
                          onClick={() =>
                            void run({
                              kind: "import",
                              command: { requestId: crypto.randomUUID(), candidateId: candidate },
                            })
                          }
                        >
                          {pending ? "Importing…" : "Import Skill"}
                        </Button>
                        <p className="text-xs text-muted-foreground">
                          Imports retain SKILL.md and supported local Markdown references. No
                          installer or Skill script runs.
                        </p>
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        The workstation has no authorized Skill folder yet. Set{" "}
                        <code>KESTREL_PLANNING_SKILL_ROOT</code> when starting Kestrel, then import
                        Skills here.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="grid gap-4">
              <Button
                variant="ghost"
                className="justify-self-start"
                onClick={() => setPreview(null)}
              >
                Back to Skills
              </Button>
              <SkillContents bundle={preview} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
