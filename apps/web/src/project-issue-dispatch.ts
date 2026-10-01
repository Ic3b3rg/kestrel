import { FactoryGitHubIssueSchema, DEFAULT_FACTORY_LIMITS } from "@kestrel/contracts";
import { z } from "zod";
import {
  hasIssueDispatchPlanRequest,
  hasActiveIssuePlanningTurn,
  withProjectIssueDispatchLock,
  readIssueDispatches,
  issueProjectBusy,
  updateIssueDispatch,
  retainIssueDispatchContext,
  attachIssueDispatchFeature,
  createFactoryFeature,
  importFactoryIssues,
  readFactoryPlans,
  readFactoryIssueImports,
  approveFactoryPlan,
  acceptPlanningMessage,
  FactoryError,
  type DatabasePool,
  type DiagnosticJobSender,
  type IssueDispatch,
} from "@kestrel/database";
import { createFactoryGitHubAdapter, type FactoryGitHubAdapter } from "./factory-github.js";
import { createProjectIssueReader } from "./project-issue-reader.js";
import {
  createCodexAppServerAgentRuntime,
  type CodexAgentRuntimePort,
} from "./codex-app-server.js";
import { validateFactoryPublication } from "./factory-issue-content.js";

const contextSchema = z.object({
  issue: FactoryGitHubIssueSchema,
  conversation: z.array(z.unknown()),
  readAt: z.string(),
  references: z.array(z.unknown()).optional(),
});

export function createProjectIssueDispatcher(
  pool: DatabasePool,
  boss: DiagnosticJobSender,
  github: FactoryGitHubAdapter = createFactoryGitHubAdapter(),
  runtime: CodexAgentRuntimePort = createCodexAppServerAgentRuntime(),
) {
  const read = createProjectIssueReader(pool, github);

  async function prepare(start: IssueDispatch, expectedVersion: number | null = null) {
    let snapshot = start.snapshot;
    if (snapshot === null) {
      const first = await read(start.project_id, start.issue_number, 1, true);
      if (
        first.issue.id !== start.issue_id ||
        first.issue.repository.id !== start.repository_id ||
        first.issue.state !== "open" ||
        !first.issue.labels?.some((label) => label.name === start.ready_label)
      )
        throw new FactoryError(
          "conflict",
          "The issue changed or no longer carries its authorized ready label. Review it before retrying.",
        );
      const conversation = [...first.comments];
      let next = first.nextPage;
      while (next !== null) {
        const page = await read(start.project_id, start.issue_number, next, true);
        conversation.push(...page.comments);
        next = page.nextPage;
        if (Buffer.byteLength(JSON.stringify(conversation)) > 160_000)
          throw new FactoryError(
            "conflict",
            "This discussion exceeds the execution context limit. Split the issue before starting it.",
          );
      }
      // Capture the issue's cited contracts before the network-free implementation starts.
      // References remain facts about this repository; they never authorize more work.
      const numbers = new Set<number>();
      for (const match of first.issue.body.matchAll(/(?:^|[\s(])#([1-9]\d*)\b/gu)) {
        const number = Number(match[1]);
        if (number !== start.issue_number) numbers.add(number);
      }
      const references = [];
      for (const number of numbers) {
        if (references.length >= 12)
          throw new FactoryError(
            "conflict",
            "This issue cites more than twelve requirements sources. Narrow its source list before starting.",
          );
        const reference = await read(start.project_id, number, 1, true);
        const comments = [...reference.comments];
        let nextPage = reference.nextPage;
        while (nextPage !== null) {
          const page = await read(start.project_id, number, nextPage, true);
          comments.push(...page.comments);
          nextPage = page.nextPage;
          if (Buffer.byteLength(JSON.stringify(comments)) > 160_000)
            throw new FactoryError(
              "conflict",
              "A linked requirements discussion exceeds the context limit.",
            );
        }
        references.push({ issue: reference.issue, conversation: comments });
      }
      snapshot = { issue: first.issue, conversation, references, readAt: new Date().toISOString() };
      if (Buffer.byteLength(JSON.stringify(snapshot)) > 180_000)
        throw new FactoryError(
          "conflict",
          "This issue exceeds the execution context limit. Split it before starting it.",
        );
      await retainIssueDispatchContext(pool, start.id, snapshot);
    }
    const context = contextSchema.parse(snapshot);
    const feature =
      start.feature_id === null
        ? await createFactoryFeature(pool, start.project_id, start.actor_id, {
            requestId: start.id,
            title: start.title.slice(0, 160),
          })
        : { id: start.feature_id };
    const imports = await importFactoryIssues(
      pool,
      start.project_id,
      feature.id,
      { requestId: start.id, issueNumbers: [start.issue_number] },
      [context.issue],
    );
    const imported = imports.issues[0];
    if (imported === undefined)
      throw new FactoryError("conflict", "The selected issue was not imported.");
    await attachIssueDispatchFeature(pool, start.id, feature.id);
    await acceptPlanningMessage(
      pool,
      boss,
      start.project_id,
      feature.id,
      {
        requestId: start.plan_request_id,
        text: `The Operator explicitly authorized development of ${context.issue.url} by starting it from the Project board. Prepare exactly one Work Item bound to imported issue ${imported.id}. Read the complete retained issue and conversation provided in issueExecutionContext, including its acceptance requirements. Derive the operational plan and concrete verification from the committed repository context. Do not create additional tracker issues or broaden the request. Use the retained linked contracts and prerequisite state, then use read_project to inspect relevant code, tests and omitted documents before requesting input. Resolve implementation details and verification commands from repository conventions yourself. Ask only for a consequential product choice that remains genuinely unresolved after these reads; a missing source or technical failure is not a product decision. Never invent requirements. This command already authorizes execution under the Project implementation profile, without another approval dialog. Use limits ${JSON.stringify(DEFAULT_FACTORY_LIMITS)}.`,
      },
      { expectedVersion },
      await runtime.readConnection(),
    );
    await updateIssueDispatch(pool, start.id, "preparing");
  }

  return async (signal?: AbortSignal): Promise<void> => {
    await withProjectIssueDispatchLock(pool, async () => {
      const projects = new Set<string>();
      for (const start of await readIssueDispatches(pool)) {
        if (signal?.aborted) return;
        if (
          start.feature_state !== null &&
          ["in_review", "completed", "cancelled"].includes(start.feature_state)
        ) {
          await updateIssueDispatch(pool, start.id, "done");
          continue;
        }
        if (projects.has(start.project_id)) continue;
        projects.add(start.project_id);
        if (
          start.state === "blocked" ||
          start.state === "running" ||
          (await issueProjectBusy(pool, start))
        )
          continue;
        try {
          if (start.feature_id === null) {
            await prepare(start);
            continue;
          }
          const plans = await readFactoryPlans(pool, start.project_id, start.feature_id);
          if (plans.approval !== null) {
            await updateIssueDispatch(pool, start.id, "running");
            continue;
          }
          if (!(await hasIssueDispatchPlanRequest(pool, start))) {
            if (await hasActiveIssuePlanningTurn(pool, start.feature_id)) continue;
            await prepare(start, plans.current?.version ?? null);
            continue;
          }
          if (plans.generation === null) {
            await prepare(start);
            continue;
          }
          if (["queued", "running"].includes(plans.generation.state)) continue;
          if (plans.current === null || plans.generation.state !== "completed")
            throw new FactoryError(
              "conflict",
              plans.generation.question ??
                "Preparation stopped before producing a plan. Retry preparation.",
            );
          const items = plans.current.document.workItems;
          const imports = await readFactoryIssueImports(pool, start.project_id, start.feature_id);
          const selected = imports.issues.find(
            (entry) =>
              entry.issue.id === start.issue_id &&
              entry.issue.repository.id === start.repository_id,
          );
          if (
            items.length !== 1 ||
            selected === undefined ||
            items[0]?.importedIssueId !== selected.id
          )
            throw new FactoryError(
              "conflict",
              "The generated plan must implement only the selected issue. Open the work to resolve its scope.",
            );
          await approveFactoryPlan(
            pool,
            start.project_id,
            start.feature_id,
            start.actor_id,
            plans.current.version,
            start.id,
            undefined,
            validateFactoryPublication,
            await runtime.readConnection(),
          );
          await updateIssueDispatch(pool, start.id, "running");
        } catch (error) {
          await updateIssueDispatch(
            pool,
            start.id,
            "blocked",
            error instanceof FactoryError
              ? (error.detail ?? "This work needs attention before it can start.")
              : "The issue or runtime could not be read. Restore access and retry this work.",
          );
        }
      }
    });
  };
}
