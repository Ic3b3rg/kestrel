import {
  FeatureSchema,
  KestrelIdSchema,
  PlanningFeatureRequestSchema,
  PlanningFeatureStartedSchema,
  RenameFactoryFeatureCommandSchema,
  StartPlanningFeatureCommandSchema,
  type RenameFactoryFeatureCommand,
  type StartPlanningFeatureCommand,
} from "@kestrel/contracts";
import { authenticatedMutationHeaders, featurePath, requireJson } from "./api.js";

const planningPath = (projectId: string) =>
  `/api/v1/projects/${KestrelIdSchema.parse(projectId)}/planning`;
export async function fetchPlanningFeatureRequest(
  projectId: string,
  requestId: string,
  signal?: AbortSignal,
) {
  return requireJson(
    await fetch(
      `${planningPath(projectId)}/${StartPlanningFeatureCommandSchema.shape.requestId.parse(requestId)}`,
      {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: signal ?? null,
      },
    ),
    PlanningFeatureRequestSchema,
    "planning request",
  );
}
export async function startPlanningFeature(
  projectId: string,
  command: StartPlanningFeatureCommand,
) {
  return requireJson(
    await fetch(planningPath(projectId), {
      method: "POST",
      credentials: "same-origin",
      headers: authenticatedMutationHeaders(),
      body: JSON.stringify(StartPlanningFeatureCommandSchema.parse(command)),
    }),
    PlanningFeatureStartedSchema,
    "started planning conversation",
  );
}
export async function renameFactoryFeature(
  projectId: string,
  featureId: string,
  command: RenameFactoryFeatureCommand,
) {
  return requireJson(
    await fetch(`${featurePath(projectId, featureId)}/title`, {
      method: "POST",
      credentials: "same-origin",
      headers: authenticatedMutationHeaders(),
      body: JSON.stringify(RenameFactoryFeatureCommandSchema.parse(command)),
    }),
    FeatureSchema,
    "renamed Feature",
  );
}
