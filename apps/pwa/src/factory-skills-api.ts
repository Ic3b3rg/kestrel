import type { z } from "zod";
import {
  FeaturePlanningSkillsSchema,
  InstallPlanningSkillCommandSchema,
  PlanningSkillBundleSchema,
  PlanningSkillCandidatesSchema,
  PlanningSkillCatalogSchema,
  PlanningSkillDigestSchema,
  SelectPlanningSkillsCommandSchema,
  type InstallPlanningSkillCommand,
  type SelectPlanningSkillsCommand,
} from "@kestrel/contracts";
import { authenticatedMutationHeaders, featurePath, requireJson } from "./api.js";

async function read<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  return requireJson(
    await fetch(path, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    }),
    schema,
    "planning Skills",
  );
}
export const fetchPlanningSkillCatalog = (signal?: AbortSignal) =>
  read("/api/v1/planning-skills", PlanningSkillCatalogSchema, signal);
export const fetchPlanningSkillCandidates = (signal?: AbortSignal) =>
  read("/api/v1/planning-skills/candidates", PlanningSkillCandidatesSchema, signal);
export const fetchPlanningSkill = (digest: string, signal?: AbortSignal) =>
  read(
    `/api/v1/planning-skills/${PlanningSkillDigestSchema.parse(digest)}`,
    PlanningSkillBundleSchema,
    signal,
  );
export async function importPlanningSkill(command: InstallPlanningSkillCommand) {
  return requireJson(
    await fetch("/api/v1/planning-skills/install", {
      method: "POST",
      credentials: "same-origin",
      headers: authenticatedMutationHeaders(),
      body: JSON.stringify(InstallPlanningSkillCommandSchema.parse(command)),
    }),
    PlanningSkillBundleSchema,
    "imported Skill",
  );
}
export async function selectPlanningSkills(
  projectId: string,
  featureId: string,
  command: SelectPlanningSkillsCommand,
) {
  return requireJson(
    await fetch(`${featurePath(projectId, featureId)}/skills`, {
      method: "POST",
      credentials: "same-origin",
      headers: authenticatedMutationHeaders(),
      body: JSON.stringify(SelectPlanningSkillsCommandSchema.parse(command)),
    }),
    FeaturePlanningSkillsSchema,
    "selected Skills",
  );
}
