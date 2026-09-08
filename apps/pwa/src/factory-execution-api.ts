import {
  FactoryExecutionSchema,
  FactoryExecutionRunSchema,
  KestrelIdSchema,
  type FactoryExecution,
  type FactoryExecutionRun,
} from "@kestrel/contracts";
import { featurePath, InvalidServerResponseError, requireJson } from "./api.js";

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
  if (run.featureId !== featureId || run.id !== runId) {
    throw new InvalidServerResponseError("The server returned a different execution attempt");
  }
  return run;
}
