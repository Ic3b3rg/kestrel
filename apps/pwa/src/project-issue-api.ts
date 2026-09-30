import {
  KestrelIdSchema,
  ProjectIssueDiscussionSchema,
  ProjectBoardSettingsSchema,
  ProjectIssueStartSchema,
} from "@kestrel/contracts";
import { z } from "zod";
import { authenticatedMutationHeaders, requireJson } from "./api.js";

const path = (projectId: string) => `/api/v1/projects/${KestrelIdSchema.parse(projectId)}/board`;
export async function fetchProjectIssue(
  projectId: string,
  number: number,
  page = 1,
  signal?: AbortSignal,
) {
  return requireJson(
    await fetch(`${path(projectId)}/issues/${String(number)}?page=${String(page)}`, {
      credentials: "same-origin",
      signal: signal ?? null,
    }),
    ProjectIssueDiscussionSchema,
    "issue discussion",
  );
}
export async function startProjectIssue(projectId: string, issueNumber: number, requestId: string) {
  return requireJson(
    await fetch(`${path(projectId)}/start`, {
      method: "POST",
      credentials: "same-origin",
      headers: authenticatedMutationHeaders(),
      body: JSON.stringify({ issueNumber, requestId }),
    }),
    z.object({ id: KestrelIdSchema }),
    "issue start",
  );
}
export async function fetchProjectIssueStart(
  projectId: string,
  startId: string,
  signal?: AbortSignal,
) {
  return requireJson(
    await fetch(`${path(projectId)}/starts/${KestrelIdSchema.parse(startId)}`, {
      credentials: "same-origin",
      signal: signal ?? null,
    }),
    ProjectIssueStartSchema,
    "issue conversation",
  );
}
export async function changeProjectIssueStart(
  projectId: string,
  id: string,
  action: "cancel" | "retry",
) {
  return requireJson(
    await fetch(`${path(projectId)}/starts/${KestrelIdSchema.parse(id)}/${action}`, {
      method: "POST",
      credentials: "same-origin",
      headers: authenticatedMutationHeaders(),
      body: "{}",
    }),
    z.object({ id: KestrelIdSchema }),
    "queued work",
  );
}
export async function fetchBoardSettings(projectId: string, signal?: AbortSignal) {
  return requireJson(
    await fetch(`${path(projectId)}/settings`, {
      credentials: "same-origin",
      signal: signal ?? null,
    }),
    ProjectBoardSettingsSchema,
    "board settings",
  );
}
export async function saveBoardSettings(projectId: string, readyLabel: string) {
  return requireJson(
    await fetch(`${path(projectId)}/settings`, {
      method: "POST",
      credentials: "same-origin",
      headers: authenticatedMutationHeaders(),
      body: JSON.stringify({ readyLabel }),
    }),
    ProjectBoardSettingsSchema,
    "board settings",
  );
}
