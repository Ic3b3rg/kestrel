import { KestrelIdSchema } from "@kestrel/contracts";

export type AppRoute =
  | { kind: "feature"; projectId: string; featureId: string }
  | { kind: "not_found" }
  | { kind: "project"; projectId: string; proposalId?: string }
  | { kind: "projects" }
  | { kind: "settings"; projectId?: string };

export function readAppRoute(pathname: string, search = ""): AppRoute {
  if (pathname === "/") return { kind: "projects" };
  if (pathname === "/settings") {
    const projectId = KestrelIdSchema.safeParse(new URLSearchParams(search).get("projectId"));
    return { kind: "settings", ...(projectId.success ? { projectId: projectId.data } : {}) };
  }
  const match = /^\/projects\/([^/]+)(?:\/features\/([^/]+))?$/u.exec(pathname);
  if (match === null) return { kind: "not_found" };
  try {
    const projectId = KestrelIdSchema.safeParse(decodeURIComponent(match[1] ?? ""));
    if (match[2] !== undefined) {
      const featureId = KestrelIdSchema.safeParse(decodeURIComponent(match[2]));
      return projectId.success && featureId.success
        ? { kind: "feature", projectId: projectId.data, featureId: featureId.data }
        : { kind: "not_found" };
    }
    const proposalId = KestrelIdSchema.safeParse(new URLSearchParams(search).get("proposalId"));
    return projectId.success
      ? {
          kind: "project",
          projectId: projectId.data,
          ...(proposalId.success ? { proposalId: proposalId.data } : {}),
        }
      : { kind: "not_found" };
  } catch {
    return { kind: "not_found" };
  }
}

export function appPath(route: Exclude<AppRoute, { kind: "not_found" }>): string {
  switch (route.kind) {
    case "feature":
      return `/projects/${encodeURIComponent(route.projectId)}/features/${encodeURIComponent(route.featureId)}`;
    case "projects":
      return "/";
    case "settings":
      return `/settings${route.projectId === undefined ? "" : `?projectId=${encodeURIComponent(route.projectId)}`}`;
    case "project":
      return `/projects/${encodeURIComponent(route.projectId)}${route.proposalId === undefined ? "" : `?proposalId=${encodeURIComponent(route.proposalId)}`}`;
  }
}
