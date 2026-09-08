import {
  GitHubPlanningSkillBundleSchema,
  InstallGitHubPlanningSkillCommandSchema,
  PreviewGitHubPlanningSkillCommandSchema,
  type GitHubPlanningSkillBundle,
  type InstallGitHubPlanningSkillCommand,
  type PreviewGitHubPlanningSkillCommand,
} from "@kestrel/contracts";
import { authenticatedMutationHeaders, InvalidServerResponseError, requireJson } from "./api.js";

async function post(
  path: string,
  command: unknown,
  signal?: AbortSignal,
): Promise<GitHubPlanningSkillBundle> {
  return requireJson(
    await fetch(`/api/v1/planning-skills/github/${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: authenticatedMutationHeaders(),
      body: JSON.stringify(command),
      signal: signal ?? null,
    }),
    GitHubPlanningSkillBundleSchema,
    "GitHub Skill",
  );
}

export async function previewGitHubPlanningSkill(
  input: PreviewGitHubPlanningSkillCommand,
  signal?: AbortSignal,
): Promise<GitHubPlanningSkillBundle> {
  const command = PreviewGitHubPlanningSkillCommandSchema.parse(input);
  const bundle = await post("preview", command, signal);
  if (
    command.kind === "starter"
      ? bundle.name !== command.starter
      : bundle.source.owner.toLowerCase() !== command.owner.toLowerCase() ||
        bundle.source.repository.toLowerCase() !== command.repository.toLowerCase() ||
        bundle.source.path !== command.path ||
        bundle.source.requestedRef !== command.ref
  )
    throw new InvalidServerResponseError("The server returned a different Skill source");
  return bundle;
}

export async function installGitHubPlanningSkill(
  input: InstallGitHubPlanningSkillCommand,
  signal?: AbortSignal,
): Promise<GitHubPlanningSkillBundle> {
  const command = InstallGitHubPlanningSkillCommandSchema.parse(input);
  const bundle = await post("install", command, signal);
  if (bundle.contentDigest !== command.digest)
    throw new InvalidServerResponseError("The server installed a different Skill version");
  return bundle;
}
