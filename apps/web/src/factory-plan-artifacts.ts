import {
  FeaturePlanDocumentSchema,
  validateFeaturePlan,
  type FeaturePlanDocument,
  type PlanningContext,
} from "@kestrel/contracts";

import { CodexPlanningError } from "./codex-planning-runtime.js";

export function parseGeneratedFeaturePlan(text: string): FeaturePlanDocument {
  try {
    const plan = FeaturePlanDocumentSchema.parse(JSON.parse(text));
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
  ].join("\n\n");
}

export function renderFeaturePlanArtifacts({
  title,
  version,
  plan,
  context,
}: {
  title: string;
  version: number;
  plan: FeaturePlanDocument;
  context: PlanningContext | null;
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
  ];
  const workItems = plan.workItems.map((item, index) =>
    [
      `### ${String(index + 1)}. ${item.key} — ${item.title}`,
      item.description,
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
        ...limitsAndSources,
      ].join("\n\n") + "\n",
  };
}
