import type { FeaturePlanDocument } from "@kestrel/contracts";
import { FactoryError } from "@kestrel/database";

const list = (items: string[]) =>
  items.length === 0 ? "None." : items.map((item) => `- ${item}`).join("\n");

export function factoryProviderMarker(operationId: string): string {
  return `<!-- kestrel-publication:v1:${operationId} -->`;
}

export function renderFactoryIssueContent({
  title,
  version,
  plan,
  itemKey,
  featureUrl,
  marker,
  dependencies,
  column = "To do",
  pullRequestUrl,
}: {
  title: string;
  version: number;
  plan: FeaturePlanDocument;
  itemKey: string;
  featureUrl: string | null;
  marker: string;
  dependencies: Array<{ key: string; url: string }>;
  column?: "To do" | "In progress" | "In review" | "Completed";
  pullRequestUrl?: string;
}): string {
  const item = plan.workItems.find(({ key }) => key === itemKey);
  if (item === undefined)
    throw new FactoryError("invalid_plan", "The approved Work Item is missing");
  const body =
    [
      marker,
      `## ${title}`,
      `Plan version ${String(version)} · Work Item ${item.key} · **${column}**`,
      featureUrl === null
        ? "Open this Feature in Kestrel to inspect the approved plan and its activity."
        : `[Open Feature in Kestrel](${featureUrl})`,
      ...(pullRequestUrl === undefined ? [] : [`Feature pull request: ${pullRequestUrl}`]),
      "Kestrel owns priority and execution. Issue edits, labels and comments do not change the approved scope or start work. Completion requires confirmed feature merge.",
      "## Objective",
      plan.objective,
      "## Included scope",
      list(plan.scope.includes),
      "## Excluded scope",
      list(plan.scope.excludes),
      "## Required outcomes",
      list(
        plan.acceptance
          .filter(({ key }) => item.requirementKeys.includes(key))
          .map(({ key, outcome }) => `${key}: ${outcome}`),
      ),
      "## Work",
      item.description,
      "## Acceptance criteria",
      list(item.acceptance),
      "## Verification",
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
      "## Dependencies",
      list(dependencies.map(({ key, url }) => `${key}: ${url}`)),
      "## Approved execution limits",
      list([
        `${String(plan.limits.maxConcurrentProjects)} concurrent Projects`,
        "1 active Feature per Project",
        `${String(plan.limits.attemptTimeoutSeconds)} seconds per execution attempt`,
      ]),
    ].join("\n\n") + "\n";
  if (Buffer.byteLength(body) > 65_000)
    throw new FactoryError(
      "invalid_plan",
      `Work Item ${item.key} exceeds the GitHub issue detail limit; shorten or split it before approval`,
    );
  return body;
}

/** Approval checks the worst allowed provider-link length; no approved text is truncated later. */
export function validateFactoryPublication(input: {
  title: string;
  version: number;
  plan: FeaturePlanDocument;
  featureUrl?: string;
}) {
  for (const item of input.plan.workItems) {
    renderFactoryIssueContent({
      ...input,
      itemKey: item.key,
      featureUrl: input.featureUrl ?? null,
      marker: factoryProviderMarker("00000000-0000-4000-8000-000000000000"),
      dependencies: item.dependsOn.map((key) => ({
        key,
        url: `https://github.com/${"x".repeat(100)}/${"x".repeat(100)}/issues/2147483647`,
      })),
    });
  }
}
