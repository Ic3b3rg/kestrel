import { useEffect, useId, useMemo, useRef, useState, type SyntheticEvent } from "react";
import {
  CreateChangeIntentVersionCommandSchema,
  type ChangeIntentSource,
  type ChangeIntentVersionCreated,
  type ProjectInbox,
} from "@kestrel/contracts";
import { CheckCircle2, CircleHelp, GitCommitHorizontal, PencilLine } from "lucide-react";

import { ApiClientError, createChangeIntentVersion } from "./api.js";
import { Button } from "./components/ui/button.js";
import { Label } from "./components/ui/label.js";
import { Textarea } from "./components/ui/textarea.js";

type Proposal = Extract<
  ProjectInbox["projects"][number]["changeProposals"][number],
  { kind: "provider_observed" }
>;

export interface ExternalChangeIntentPanelProps {
  createVersion?: typeof createChangeIntentVersion;
  disabled: boolean;
  onAuthenticationError?: (error: unknown) => boolean;
  onCreated: (result: ChangeIntentVersionCreated) => void;
  projectId: string;
  proposal: Proposal;
}

function nonEmptyLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function sourceLabel(source: ChangeIntentSource): string {
  switch (source.kind) {
    case "operator_input":
    case "approved_feature_plan":
      return "Confirmed by you";
    case "provider_field":
      return `Stated in GitHub ${source.provenance.kind === "provider_field" ? source.provenance.field : "pull request"}`;
    case "commit_author":
    case "commit_message":
      return "Inferred from a commit";
  }
}

function purposeAuthority(proposal: Proposal): {
  label: string;
  detail: string;
  icon: typeof CheckCircle2;
} {
  const sources = proposal.changeIntent?.sources ?? [];
  if (sources.some(({ kind }) => kind === "operator_input" || kind === "approved_feature_plan")) {
    return {
      label: "Operator confirmed",
      detail: "You explicitly confirmed this purpose in Kestrel.",
      icon: CheckCircle2,
    };
  }
  if (sources.some(({ kind }) => kind === "provider_field")) {
    return {
      label: "Pull request stated",
      detail:
        "Kestrel derived this purpose from the GitHub title or description. You have not confirmed it.",
      icon: CircleHelp,
    };
  }
  if (sources.length > 0) {
    return {
      label: "Inferred",
      detail: "Kestrel inferred this purpose from commit metadata. You have not confirmed it.",
      icon: GitCommitHorizontal,
    };
  }
  return {
    label: "Pull request stated",
    detail: "Kestrel is using the GitHub pull request text as an unconfirmed starting point.",
    icon: CircleHelp,
  };
}

export function ExternalChangeIntentPanel({
  createVersion = createChangeIntentVersion,
  disabled,
  onAuthenticationError,
  onCreated,
  projectId,
  proposal,
}: ExternalChangeIntentPanelProps) {
  const intent = proposal.changeIntent;
  const fallback = proposal.title;
  const providerDescription = proposal.body?.trim();
  const [objective, setObjective] = useState(intent?.objective ?? fallback);
  const [scope, setScope] = useState(
    (intent?.scopeBoundaries.length
      ? intent.scopeBoundaries
      : ["The exact changes in this pull request"]
    ).join("\n"),
  );
  const [outcomes, setOutcomes] = useState(
    (intent?.acceptanceOutcomes.length
      ? intent.acceptanceOutcomes
      : [intent?.objective ?? fallback]
    ).join("\n"),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const id = useId();
  const authority = purposeAuthority(proposal);
  const AuthorityIcon = authority.icon;
  const selectedSourceIds = useMemo(
    () =>
      (intent?.sources ?? [])
        .filter(({ kind }) => kind !== "operator_input" && kind !== "approved_feature_plan")
        .map(({ id: sourceId }) => sourceId)
        .filter((sourceId) =>
          proposal.changeIntentCandidates.some(({ id: candidateId }) => candidateId === sourceId),
        )
        .slice(0, 19),
    [intent?.sources, proposal.changeIntentCandidates],
  );

  useEffect(() => () => request.current?.abort(), []);

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedObjective = objective.trim();
    const normalizedScope = nonEmptyLines(scope);
    const normalizedOutcomes = nonEmptyLines(outcomes);
    if (!normalizedObjective || normalizedScope.length === 0 || normalizedOutcomes.length === 0) {
      setError("Add a purpose, at least one scope boundary, and at least one expected outcome.");
      return;
    }
    const parsed = CreateChangeIntentVersionCommandSchema.safeParse({
      acceptanceOutcomes: normalizedOutcomes,
      expectedProposalVersion: proposal.version,
      objective: normalizedObjective,
      operatorInput: `Operator confirmation: ${normalizedObjective}`,
      scopeBoundaries: normalizedScope,
      selectedSourceIds,
      unresolvedIssues: [],
    });
    if (!parsed.success) {
      setError("The corrected purpose is too long or contains too many entries.");
      return;
    }
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setPending(true);
    setError(null);
    try {
      const result = await createVersion(projectId, proposal.id, parsed.data, controller.signal);
      if (!controller.signal.aborted) onCreated(result);
    } catch (failure) {
      if (!controller.signal.aborted && onAuthenticationError?.(failure) !== true) {
        setError(
          failure instanceof ApiClientError
            ? failure.details.message
            : "Kestrel could not save the corrected purpose.",
        );
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(false);
      }
    }
  };

  return (
    <section
      className="grid min-w-0 gap-4 rounded-xl border border-border bg-card p-4 sm:p-5"
      aria-labelledby={`${id}-title`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Review purpose
          </p>
          <h3 id={`${id}-title`} className="mt-1 text-lg font-semibold">
            What this change is meant to do
          </h3>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs">
          <AuthorityIcon className="size-3.5" aria-hidden="true" /> {authority.label}
        </span>
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(15rem,0.7fr)]">
        <div className="min-w-0 space-y-2">
          <p className="text-base font-medium">{intent?.objective ?? fallback}</p>
          <p className="text-sm text-muted-foreground">{authority.detail}</p>
          {(intent?.sources ?? []).length === 0 ? null : (
            <ul className="flex flex-wrap gap-2" aria-label="Purpose sources">
              {intent?.sources.map((source) => (
                <li
                  key={`${source.id}:${source.version}`}
                  className="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground"
                  title={source.text}
                >
                  {sourceLabel(source)} · {source.label}
                </li>
              ))}
            </ul>
          )}
        </div>
        <dl className="grid min-w-0 gap-3 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">In scope</dt>
            <dd>
              {intent?.scopeBoundaries.length
                ? intent.scopeBoundaries.join(" · ")
                : "The exact pull request change; boundaries not yet confirmed."}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Expected result</dt>
            <dd>
              {intent?.acceptanceOutcomes.length
                ? intent.acceptanceOutcomes.join(" · ")
                : "No separate acceptance outcomes were confirmed."}
            </dd>
          </div>
        </dl>
      </div>

      {providerDescription ? (
        <details className="rounded-lg border border-border bg-background p-3">
          <summary className="cursor-pointer text-sm font-medium">GitHub description</summary>
          <p className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground">
            {providerDescription}
          </p>
        </details>
      ) : null}

      <details className="rounded-lg border border-border bg-background p-3">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
          <PencilLine className="size-4" aria-hidden="true" /> Correct this explanation
        </summary>
        <form className="mt-4 grid gap-3" onSubmit={(event) => void submit(event)} noValidate>
          <p className="text-sm text-muted-foreground">
            Saving records these fields as your explicit confirmation. It does not change GitHub or
            the pull request.
          </p>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-objective`}>Purpose</Label>
            <Textarea
              id={`${id}-objective`}
              rows={3}
              value={objective}
              disabled={disabled || pending}
              onChange={(event) => setObjective(event.currentTarget.value)}
            />
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2 sm:gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-scope`}>In scope · one item per line</Label>
              <Textarea
                id={`${id}-scope`}
                rows={4}
                value={scope}
                disabled={disabled || pending}
                onChange={(event) => setScope(event.currentTarget.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-outcomes`}>Expected results · one item per line</Label>
              <Textarea
                id={`${id}-outcomes`}
                rows={4}
                value={outcomes}
                disabled={disabled || pending}
                onChange={(event) => setOutcomes(event.currentTarget.value)}
              />
            </div>
          </div>
          {error === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-fit" disabled={disabled || pending}>
            {pending ? "Saving confirmation…" : "Save confirmed purpose"}
          </Button>
        </form>
      </details>
    </section>
  );
}
