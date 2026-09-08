import {
  GeneratedFeaturePlanDocumentSchema,
  validateFeaturePlan,
  type FeaturePlanDocument,
  type PlanningContext,
  type ImportedFactoryIssue,
} from "@kestrel/contracts";

import { CodexPlanningError } from "./codex-planning-runtime.js";

export function parseGeneratedFeaturePlan(text: string): FeaturePlanDocument {
  try {
    const plan = GeneratedFeaturePlanDocumentSchema.parse(JSON.parse(text));
    if (validateFeaturePlan(plan).length > 0) throw new CodexPlanningError("invalid_response");
    return plan;
  } catch {
    throw new CodexPlanningError("invalid_response");
  }
}

function markdownList(items: readonly string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

function markdownCode(value: string): string {
  let fence = "`";
  while (value.includes(fence)) fence += "`";
  const padding = /^[` ]|[` ]$/u.test(value) ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}

function proposedDocumentsMarkdown(plan: FeaturePlanDocument, contents: boolean): string[] {
  if ((plan.proposedDocuments?.length ?? 0) === 0) return [];
  return [
    "## Proposed Project documents",
    "These are proposed Markdown, not committed Project documents. Only their owning Work Items may apply them after exact plan approval. The planning sources below record the inputs supplied for this version.",
    ...(plan.proposedDocuments ?? []).map((document) => {
      let fence = "```";
      while (document.markdown.includes(fence)) fence += "`";
      return [
        `### ${document.key} — ${document.kind === "adr" ? "ADR" : "Glossary"}`,
        `${document.pathIsProvisional ? "Provisional path" : "Proposed path"}: ${markdownCode(document.path)}`,
        `Owning Work Item: ${markdownCode(document.workItemKey)}`,
        ...(contents
          ? [
              `${fence}markdown\n${document.markdown}${document.markdown.endsWith("\n") ? "" : "\n"}${fence}`,
            ]
          : ["The complete proposed Markdown is retained in the Feature Plan artifact."]),
      ].join("\n\n");
    }),
  ];
}

function sourceContextMarkdown(context: PlanningContext | null): string {
  if (context === null) {
    return "## Planning sources\n\nNo planning source context was available. Source commit and document references are unavailable.";
  }
  return [
    "## Planning sources",
    context.commitId === null
      ? "Source commit: Unavailable."
      : `Source commit: \`${context.commitId}\``,
    context.documents.length > 0
      ? markdownList(
          context.documents.map(
            (document) => `${markdownCode(document.path)} — blob \`${document.objectId}\``,
          ),
        )
      : "No committed planning documents were available.",
    ...(context.notice === null ? [] : [`Context notice: ${context.notice}`]),
    ...((context.skills?.length ?? 0) === 0
      ? []
      : [
          "Selected planning Skills:",
          markdownList(
            (context.skills ?? []).map(
              (skill) =>
                `${markdownCode("$" + skill.name)} from ${markdownCode(skill.source.label)} — retained version ${markdownCode(skill.contentDigest)}`,
            ),
          ),
        ]),
  ].join("\n\n");
}

export function renderFeaturePlanArtifacts({
  title,
  version,
  plan,
  context,
  imports = [],
}: {
  title: string;
  version: number;
  plan: FeaturePlanDocument;
  context: PlanningContext | null;
  imports?: ImportedFactoryIssue[];
}): { planMarkdown: string; specMarkdown: string } {
  const intent = [
    `Version: ${String(version)}`,
    "## Objective",
    plan.objective,
    "## Scope",
    "### Included",
    markdownList(plan.scope.includes),
    "### Excluded",
    markdownList(plan.scope.excludes),
    "## Acceptance outcomes",
  ];
  const limitsAndSources = [
    "## Execution limits",
    markdownList([
      `Concurrent Projects: ${String(plan.limits.maxConcurrentProjects)}`,
      `Active Features per Project: ${String(plan.limits.maxActiveFeaturesPerProject)}`,
      `Execution attempt timeout: ${String(plan.limits.attemptTimeoutSeconds)} seconds`,
    ]),
    sourceContextMarkdown(context),
    ...(imports.length === 0
      ? []
      : [
          "## Imported issue snapshots",
          "These immutable snapshots are planning context, not execution authority. The full original text is retained in Kestrel.",
          ...imports.map(
            (imported) =>
              `- ${imported.issue.url} — ${imported.issue.title}\n  Snapshot: ${imported.id}; captured ${imported.importedAt}`,
          ),
        ]),
  ];
  const workItems = plan.workItems.map((item, index) =>
    [
      `### ${String(index + 1)}. ${item.key} — ${item.title}`,
      item.description,
      `GitHub issue: ${item.importedIssueId === null ? "Create a new issue after approval" : (imports.find(({ id }) => id === item.importedIssueId)?.issue.url ?? `Imported snapshot ${item.importedIssueId}`)}`,
      `Requirements: ${item.requirementKeys.join(", ")}`,
      `Dependencies: ${item.dependsOn.length > 0 ? item.dependsOn.join(", ") : "None"}`,
      "#### Acceptance",
      markdownList(item.acceptance),
      "#### Verification",
      ...item.verification.map((command) =>
        [
          "```json",
          JSON.stringify(
            {
              argv: [command.program, ...command.args],
              cwd: command.cwd,
              timeoutSeconds: command.timeoutSeconds,
            },
            null,
            2,
          ),
          "```",
        ].join("\n"),
      ),
    ].join("\n\n"),
  );

  return {
    planMarkdown:
      [
        `# ${title} — Feature Plan`,
        ...intent,
        markdownList(
          plan.acceptance.map((requirement) => `**${requirement.key}**: ${requirement.outcome}`),
        ),
        "## Ordered Work Items",
        ...workItems,
        ...proposedDocumentsMarkdown(plan, true),
        ...limitsAndSources,
      ].join("\n\n") + "\n",
    specMarkdown:
      [
        `# ${title} — Specification`,
        ...intent,
        ...plan.acceptance.map((requirement) =>
          [
            `- **${requirement.key}**: ${requirement.outcome}`,
            `  Work Items: ${plan.workItems
              .filter((item) => item.requirementKeys.includes(requirement.key))
              .map((item) => item.key)
              .join(", ")}`,
          ].join("\n"),
        ),
        ...proposedDocumentsMarkdown(plan, false),
        ...limitsAndSources,
      ].join("\n\n") + "\n",
  };
}
