import { useEffect, useId, useMemo, useRef, useState, type SyntheticEvent } from "react";

import {
  CreateChangeIntentVersionCommandSchema,
  evaluateChangeIntentResolution,
  type ChangeIntentSource,
  type ChangeIntentVersionCreated,
  type CreateChangeIntentVersionCommand,
  type ProjectInbox,
} from "@kestrel/contracts";

import { ApiClientError, createChangeIntentVersion } from "./api.js";

type Proposal = ProjectInbox["projects"][number]["changeProposals"][number];

export interface ChangeIntentEditorProps {
  createVersion?: typeof createChangeIntentVersion;
  disabled: boolean;
  onAuthenticationError?: (error: unknown) => boolean;
  onCreated: (result: ChangeIntentVersionCreated) => void;
  projectId: string;
  proposal: Proposal;
}

const issueFieldLabels = {
  acceptance_outcomes: "Ordered acceptance outcomes",
  objective: "Objective",
  scope_boundaries: "Scope boundaries",
  sources: "Selected sources",
} as const;

const draftIssueFieldLabels = {
  acceptance_outcomes: "ordered acceptance outcomes",
  objective: "objective",
  scope_boundaries: "scope boundaries",
  sources: "selected sources or Operator input",
} as const;

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function sourceProvenance(source: ChangeIntentSource): string {
  const provenance = source.provenance;
  switch (provenance.kind) {
    case "provider_field":
      return `GitHub ${provenance.field} · observed ${provenance.observedAt} · ${provenance.canonicalUrl}`;
    case "commit_author":
    case "commit_message":
      return `${provenance.side} ${provenance.objectId.slice(0, 12)} · ${provenance.ref}`;
    case "operator_input":
      return "Operator-confirmed input";
  }
}

function currentIssue(
  issue: NonNullable<Proposal["changeIntent"]>["resolution"]["issues"][number],
) {
  return issue.kind === "missing"
    ? `${issueFieldLabels[issue.field]} ${issue.field === "acceptance_outcomes" ? "are" : "is"} missing`
    : `${issue.kind === "ambiguous" ? "Ambiguous" : "Contradictory"}: ${issue.description}`;
}

function SourceSnapshot({ source }: { source: ChangeIntentSource }) {
  return (
    <span className="intent-source-snapshot">
      <strong>{source.label}</strong>
      <span>{source.text}</span>
      <small>
        {source.id} · version {source.version}
      </small>
      <small>{sourceProvenance(source)}</small>
    </span>
  );
}

export function ChangeIntentEditor({
  createVersion = createChangeIntentVersion,
  disabled,
  onAuthenticationError,
  onCreated,
  projectId,
  proposal,
}: ChangeIntentEditorProps) {
  const current = proposal.changeIntent;
  const operatorSource = current?.sources.find(({ kind }) => kind === "operator_input");
  const ambiguityIssue = current?.resolution.issues.find(({ kind }) => kind === "ambiguous");
  const contradictionIssue = current?.resolution.issues.find(
    ({ kind }) => kind === "contradictory",
  );
  const [objective, setObjective] = useState(current?.objective ?? "");
  const [scope, setScope] = useState(current?.scopeBoundaries.join("\n") ?? "");
  const [outcomes, setOutcomes] = useState(current?.acceptanceOutcomes.join("\n") ?? "");
  const [operatorInput, setOperatorInput] = useState(operatorSource?.text ?? "");
  const [ambiguity, setAmbiguity] = useState(
    ambiguityIssue?.kind === "ambiguous" ? ambiguityIssue.description : "",
  );
  const [contradiction, setContradiction] = useState(
    contradictionIssue?.kind === "contradictory" ? contradictionIssue.description : "",
  );
  const [selected, setSelected] = useState(
    () =>
      new Set(
        proposal.changeIntentCandidates
          .filter(
            (candidate) =>
              current?.sources.some(
                ({ id, version }) => id === candidate.id && version === candidate.version,
              ) === true,
          )
          .map(({ id }) => id),
      ),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const id = useId();

  useEffect(() => () => controller.current?.abort(), []);

  const command = useMemo<CreateChangeIntentVersionCommand>(
    () => ({
      acceptanceOutcomes: lines(outcomes),
      expectedProposalVersion: proposal.version,
      objective: objective.trim() || null,
      operatorInput: operatorInput.trim() || null,
      scopeBoundaries: lines(scope),
      selectedSourceIds: proposal.changeIntentCandidates
        .filter(({ id: sourceId }) => selected.has(sourceId))
        .map(({ id: sourceId }) => sourceId),
      unresolvedIssues: [
        ...(ambiguity.trim() === ""
          ? []
          : [{ kind: "ambiguous" as const, description: ambiguity.trim() }]),
        ...(contradiction.trim() === ""
          ? []
          : [{ kind: "contradictory" as const, description: contradiction.trim() }]),
      ],
    }),
    [ambiguity, contradiction, objective, operatorInput, outcomes, proposal, scope, selected],
  );
  const draftResolution = evaluateChangeIntentResolution({
    acceptanceOutcomes: command.acceptanceOutcomes,
    objective: command.objective,
    scopeBoundaries: command.scopeBoundaries,
    sourceCount: command.selectedSourceIds.length + (command.operatorInput === null ? 0 : 1),
    unresolvedIssues: command.unresolvedIssues,
  });
  const draftResolved = draftResolution.state === "resolved";
  const draftProblems = draftResolution.issues.map((issue) =>
    issue.kind === "missing" ? draftIssueFieldLabels[issue.field] : issue.kind,
  );

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = CreateChangeIntentVersionCommandSchema.safeParse(command);
    if (!parsed.success) {
      setError("Add at least one source or Operator input and keep every field within its limit.");
      return;
    }
    const active = new AbortController();
    controller.current?.abort();
    controller.current = active;
    setPending(true);
    setError(null);
    try {
      onCreated(await createVersion(projectId, proposal.id, parsed.data, active.signal));
    } catch (caught) {
      if (!active.signal.aborted && onAuthenticationError?.(caught) !== true) {
        setError(
          caught instanceof ApiClientError
            ? caught.details.message
            : "The Change Intent version could not be created. Try again.",
        );
      }
    } finally {
      if (controller.current === active) {
        controller.current = null;
        setPending(false);
      }
    }
  };

  return (
    <form className="change-intent-editor" onSubmit={(event) => void submit(event)} noValidate>
      <div className="intent-editor-heading">
        <div>
          <p>CHANGE INTENT · PROPOSAL VERSION {proposal.version}</p>
          <h5>
            {current === null
              ? "Curate the first version"
              : `Curate version ${String(current.version + 1)}`}
          </h5>
        </div>
        <strong className={draftResolved ? "intent-resolved" : "intent-unresolved"}>
          {draftResolved ? "Ready to resolve" : "Unresolved draft"}
        </strong>
      </div>

      {current === null ? null : (
        <section
          className="current-intent"
          aria-label={`Current Change Intent version ${String(current.version)}`}
        >
          <strong>{current.resolution.state === "resolved" ? "Resolved" : "Unresolved"}</strong>
          <span>Current v{current.version}</span>
          <code>Source digest {current.sourceDigest}</code>
          {current.resolution.issues.map((issue, index) => (
            <span key={`${issue.kind}:${String(index)}`}>{currentIssue(issue)}</span>
          ))}
          {current.sources.map((source) => (
            <SourceSnapshot key={source.id} source={source} />
          ))}
        </section>
      )}

      <fieldset className="intent-sources">
        <legend>Candidate sources</legend>
        {proposal.changeIntentCandidates.length === 0 ? (
          <p>No provider or commit suggestions are available. Operator input can stand alone.</p>
        ) : (
          proposal.changeIntentCandidates.map((source) => (
            <label key={source.id} htmlFor={`${id}-${source.id}`}>
              <input
                checked={selected.has(source.id)}
                disabled={disabled || pending}
                id={`${id}-${source.id}`}
                type="checkbox"
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.currentTarget.checked) next.add(source.id);
                  else next.delete(source.id);
                  setSelected(next);
                }}
              />
              <SourceSnapshot source={source} />
            </label>
          ))
        )}
      </fieldset>

      <div className="intent-fields">
        <label htmlFor={`${id}-objective`}>Objective</label>
        <textarea
          id={`${id}-objective`}
          value={objective}
          disabled={disabled || pending}
          onChange={(event) => setObjective(event.currentTarget.value)}
        />
        <label htmlFor={`${id}-scope`}>
          Scope boundaries <span>one per line</span>
        </label>
        <textarea
          id={`${id}-scope`}
          value={scope}
          disabled={disabled || pending}
          onChange={(event) => setScope(event.currentTarget.value)}
        />
        <label htmlFor={`${id}-outcomes`}>
          Ordered acceptance outcomes <span>one per line</span>
        </label>
        <textarea
          id={`${id}-outcomes`}
          value={outcomes}
          disabled={disabled || pending}
          onChange={(event) => setOutcomes(event.currentTarget.value)}
        />
        <label htmlFor={`${id}-operator`}>Operator input</label>
        <textarea
          id={`${id}-operator`}
          value={operatorInput}
          disabled={disabled || pending}
          onChange={(event) => setOperatorInput(event.currentTarget.value)}
        />
        <label htmlFor={`${id}-ambiguity`}>
          Unresolved ambiguity <span>optional</span>
        </label>
        <textarea
          id={`${id}-ambiguity`}
          value={ambiguity}
          disabled={disabled || pending}
          onChange={(event) => setAmbiguity(event.currentTarget.value)}
        />
        <label htmlFor={`${id}-contradiction`}>
          Unresolved contradiction <span>optional</span>
        </label>
        <textarea
          id={`${id}-contradiction`}
          value={contradiction}
          disabled={disabled || pending}
          onChange={(event) => setContradiction(event.currentTarget.value)}
        />
      </div>

      <p className="intent-resolution-preview">
        {draftResolved
          ? "This version can resolve when saved."
          : `This version will remain unresolved: ${draftProblems.join(", ")}.`}
      </p>
      {error === null ? null : (
        <p className="project-form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={disabled || pending}>
        {pending ? "Creating version…" : "Create Change Intent version"}
      </button>
    </form>
  );
}
