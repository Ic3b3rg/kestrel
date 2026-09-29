import type { StartFactoryWorkItemCommand } from "@kestrel/contracts";
import {
  FactoryExecutionSchema,
  FactoryExecutionRunSchema,
  FactoryGateSchema,
  ResolveFactoryGateCommandSchema,
  KestrelIdSchema,
  type FactoryExecution,
  type FactoryExecutionRun,
  type ResolveFactoryGateCommand,
} from "@kestrel/contracts";
import {
  authenticatedMutationHeaders,
  featurePath,
  InvalidServerResponseError,
  requireJson,
} from "./api.js";

export async function resolveFactoryGate(
  projectId: string,
  featureId: string,
  gateId: string,
  command: ResolveFactoryGateCommand,
  signal?: AbortSignal,
) {
  const gate = await requireJson(
    await fetch(
      `${featurePath(projectId, featureId)}/execution/gates/${encodeURIComponent(KestrelIdSchema.parse(gateId))}/resolve`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: authenticatedMutationHeaders(),
        body: JSON.stringify(ResolveFactoryGateCommandSchema.parse(command)),
        signal: signal ?? null,
      },
    ),
    FactoryGateSchema,
    "saved gate answer",
  );
  if (
    gate.id !== gateId ||
    gate.featureId !== featureId ||
    gate.approvedVersion !== command.expectedPlanVersion ||
    gate.resolution?.requestId !== command.requestId ||
    gate.resolution.answer !== command.answer ||
    gate.resolution.decision !== command.decision
  ) {
    throw new InvalidServerResponseError("The server returned a different gate answer");
  }
  return gate;
}

export async function fetchFactoryExecution(
  projectId: string,
  featureId: string,
  signal?: AbortSignal,
): Promise<FactoryExecution> {
  const response = await fetch(`${featurePath(projectId, featureId)}/execution`, {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal: signal ?? null,
  });
  const execution = await requireJson(response, FactoryExecutionSchema, "feature execution");
  if (
    execution.featureId !== featureId ||
    (execution.gate != null &&
      (execution.gate.featureId !== featureId ||
        (execution.gate.purpose === "feature_verification"
          ? !execution.finalVerification?.runs.some((run) => run.id === execution.gate?.runId)
          : !execution.workItems.some(
              (item) =>
                item.id === execution.gate?.workItemId &&
                item.runs.some((run) => run.id === execution.gate?.runId),
            )))) ||
    (execution.finalVerification?.certificate != null &&
      (execution.finalVerification.certificate.featureId !== featureId ||
        !execution.finalVerification.runs.some(
          (run) =>
            run.id === execution.finalVerification?.certificate?.runId &&
            run.state === "verified" &&
            run.writerStopped,
        ) ||
        JSON.stringify(execution.finalVerification.certificate.revision) !==
          JSON.stringify(execution.revision))) ||
    execution.workItems.some((item) => item.runs.some((run) => run.workItemId !== item.id))
  ) {
    throw new InvalidServerResponseError("The server returned execution for different work");
  }
  return execution;
}

export async function fetchFactoryExecutionRun(
  projectId: string,
  featureId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<FactoryExecutionRun> {
  const response = await fetch(
    `${featurePath(projectId, featureId)}/execution/runs/${encodeURIComponent(KestrelIdSchema.parse(runId))}`,
    {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    },
  );
  const run = await requireJson(response, FactoryExecutionRunSchema, "execution attempt");
  if (
    run.featureId !== featureId ||
    run.id !== runId ||
    (run.gate != null &&
      (run.gate.featureId !== featureId ||
        run.gate.runId !== runId ||
        run.gate.workItemId !== run.workItemId ||
        (run.gate.purpose ?? "work_item") !== (run.purpose ?? "work_item")))
  ) {
    throw new InvalidServerResponseError("The server returned a different execution attempt");
  }
  return run;
}

export async function startFactoryWorkItem(
  projectId: string,
  featureId: string,
  workItemId: string,
  command: StartFactoryWorkItemCommand,
) {
  const { StartFactoryWorkItemCommandSchema, FactoryWorkItemStartSchema } =
    await import("@kestrel/contracts");
  const result = await requireJson(
    await fetch(
      `${featurePath(projectId, featureId)}/work-items/${encodeURIComponent(KestrelIdSchema.parse(workItemId))}/start`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: authenticatedMutationHeaders(),
        body: JSON.stringify(StartFactoryWorkItemCommandSchema.parse(command)),
      },
    ),
    FactoryWorkItemStartSchema,
    "issue start",
  );
  if (result.workItemId !== workItemId || result.approvedVersion !== command.expectedVersion)
    throw new InvalidServerResponseError("The server returned a different issue start");
  return result;
}

export async function prepareGitHubIssue(projectId: string, number: number, requestId: string) {
  const { FeatureSchema } = await import("@kestrel/contracts");
  return requireJson(
    await fetch(
      `/api/v1/projects/${encodeURIComponent(KestrelIdSchema.parse(projectId))}/github-issues/${String(number)}/start`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: authenticatedMutationHeaders(),
        body: JSON.stringify({ requestId }),
      },
    ),
    FeatureSchema,
    "issue interview",
  );
}
