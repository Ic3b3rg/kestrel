import { KestrelIdSchema } from "@kestrel/contracts";

export type AppRoute =
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
  const match = /^\/projects\/([^/]+)$/u.exec(pathname);
  if (match === null) return { kind: "not_found" };
  try {
    const projectId = KestrelIdSchema.safeParse(decodeURIComponent(match[1] ?? ""));
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
    case "projects":
      return "/";
    case "settings":
      return `/settings${route.projectId === undefined ? "" : `?projectId=${encodeURIComponent(route.projectId)}`}`;
    case "project":
      return `/projects/${encodeURIComponent(route.projectId)}${route.proposalId === undefined ? "" : `?proposalId=${encodeURIComponent(route.proposalId)}`}`;
  }
}
