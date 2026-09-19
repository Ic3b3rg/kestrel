import type { FactoryConceptualReviewDraft } from "@kestrel/contracts";
import { AlertTriangle, ArrowRight, CheckCircle2, FileCode2, Footprints } from "lucide-react";

import { Button } from "./components/ui/button.js";

type ReviewNode =
  | FactoryConceptualReviewDraft["outcomes"][number]
  | FactoryConceptualReviewDraft["behavioralSteps"][number]
  | FactoryConceptualReviewDraft["evidence"][number]
  | FactoryConceptualReviewDraft["problems"][number];

export interface ReviewGraphProps {
  graph: FactoryConceptualReviewDraft;
  selectedId: string;
  onSelect: (id: string) => void;
}

function nodeTitle(node: ReviewNode): string {
  if ("title" in node) return node.title;
  return node.description;
}

function NodeButton({
  node,
  selected,
  related,
  onSelect,
  detail,
}: {
  node: ReviewNode;
  selected: boolean;
  related: boolean;
  onSelect: (id: string) => void;
  detail: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={selected}
      className={`h-auto w-full min-w-0 justify-start whitespace-normal rounded-lg p-3 text-left ${
        selected
          ? "border-primary bg-primary/10 ring-2 ring-primary/25"
          : related
            ? "border-primary/50 bg-primary/5"
            : "bg-background"
      }`}
      onClick={() => onSelect(node.id)}
    >
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="block break-words text-sm font-medium">{nodeTitle(node)}</span>
        <span className="mt-1 block break-words text-xs font-normal text-muted-foreground">
          {detail}
        </span>
      </span>
    </Button>
  );
}

export function ReviewGraph({ graph, selectedId, onSelect }: ReviewGraphProps) {
  const related = new Set(
    graph.edges
      .filter(({ from, to }) => from === selectedId || to === selectedId)
      .flatMap(({ from, to }) => [from, to]),
  );
  const groups = [
    {
      key: "outcomes",
      title: "Approved outcomes",
      icon: CheckCircle2,
      nodes: graph.outcomes,
      detail: (node: FactoryConceptualReviewDraft["outcomes"][number]) =>
        `${node.coverage.replaceAll("_", " ")} · ${node.outcomeKey}`,
    },
    {
      key: "steps",
      title: "Behavioral Steps",
      icon: Footprints,
      nodes: graph.behavioralSteps,
      detail: (node: FactoryConceptualReviewDraft["behavioralSteps"][number]) => node.change,
    },
    {
      key: "evidence",
      title: "Exact evidence",
      icon: FileCode2,
      nodes: graph.evidence,
      detail: (node: FactoryConceptualReviewDraft["evidence"][number]) =>
        `${node.side} · ${node.path}:${String(node.startLine)}–${String(node.endLine)}`,
    },
    {
      key: "problems",
      title: "Problems",
      icon: AlertTriangle,
      nodes: graph.problems,
      detail: (node: FactoryConceptualReviewDraft["problems"][number]) =>
        node.type === "finding"
          ? `${node.type} · ${node.riskLevel} risk`
          : node.type.replaceAll("_", " "),
    },
  ] as const;

  return (
    <section className="min-w-0 space-y-3" aria-label="Requirements review graph">
      <div className="overflow-x-auto pb-2">
        <div className="grid min-w-0 grid-cols-1 gap-2 lg:min-w-[58rem] lg:grid-cols-[minmax(12rem,1fr)_2rem_minmax(12rem,1fr)_2rem_minmax(12rem,1fr)_2rem_minmax(12rem,1fr)]">
          {groups.map((group, index) => {
            const Icon = group.icon;
            return (
              <div key={group.key} className="contents">
                <div className="min-w-0 rounded-xl border border-border bg-card/60 p-3">
                  <h4 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    <Icon className="size-4" aria-hidden="true" /> {group.title}
                  </h4>
                  <div className="grid gap-2">
                    {group.nodes.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                        No nodes published.
                      </p>
                    ) : null}
                    {group.nodes.map((node) => (
                      <NodeButton
                        key={node.id}
                        node={node}
                        selected={node.id === selectedId}
                        related={related.has(node.id)}
                        onSelect={onSelect}
                        detail={group.detail(node as never)}
                      />
                    ))}
                  </div>
                </div>
                {index === groups.length - 1 ? null : (
                  <div className="flex items-center justify-center text-muted-foreground">
                    <ArrowRight className="size-5 rotate-90 lg:rotate-0" aria-hidden="true" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <details className="rounded-lg border border-border bg-background p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Linked outline for keyboard review
        </summary>
        <ol className="mt-3 grid gap-2">
          {graph.edges.map((edge) => {
            const nodes = [
              ...graph.outcomes,
              ...graph.behavioralSteps,
              ...graph.evidence,
              ...graph.problems,
            ] as ReviewNode[];
            const from = nodes.find(({ id }) => id === edge.from);
            const to = nodes.find(({ id }) => id === edge.to);
            if (from === undefined || to === undefined) return null;
            return (
              <li
                key={JSON.stringify([edge.from, edge.kind, edge.to])}
                className="grid min-w-0 gap-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto min-w-0 justify-start whitespace-normal text-left [overflow-wrap:anywhere]"
                  onClick={() => onSelect(from.id)}
                >
                  {nodeTitle(from)}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {edge.kind.replaceAll("_", " ")}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto min-w-0 justify-start whitespace-normal text-left [overflow-wrap:anywhere]"
                  onClick={() => onSelect(to.id)}
                >
                  {nodeTitle(to)}
                </Button>
              </li>
            );
          })}
        </ol>
      </details>
    </section>
  );
}
