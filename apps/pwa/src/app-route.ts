import { KestrelIdSchema, StartPlanningFeatureCommandSchema } from "@kestrel/contracts";

export type AppRoute =
  | { kind: "feature"; projectId: string; featureId: string; view?: "plan" | "board" }
  | { kind: "not_found" }
  | { kind: "planning"; projectId: string; requestId: string }
  | { kind: "project"; projectId: string; proposalId?: string; view?: "pull_requests" }
  | { kind: "projects" }
  | { kind: "settings"; projectId?: string };

export function readAppRoute(pathname: string, search = ""): AppRoute {
  if (pathname === "/") return { kind: "projects" };
  if (pathname === "/settings") {
    const projectId = KestrelIdSchema.safeParse(new URLSearchParams(search).get("projectId"));
    return { kind: "settings", ...(projectId.success ? { projectId: projectId.data } : {}) };
  }
  const match = /^\/projects\/([^/]+)(?:\/(features|planning)\/([^/]+))?$/u.exec(pathname);
  if (match === null) return { kind: "not_found" };
  try {
    const projectId = KestrelIdSchema.safeParse(decodeURIComponent(match[1] ?? ""));
    if (match[2] === "planning") {
      const requestId = StartPlanningFeatureCommandSchema.shape.requestId.safeParse(
        decodeURIComponent(match[3] ?? ""),
      );
      return projectId.success && requestId.success
        ? { kind: "planning", projectId: projectId.data, requestId: requestId.data }
        : { kind: "not_found" };
    }
    if (match[2] === "features") {
      const featureId = KestrelIdSchema.safeParse(decodeURIComponent(match[3] ?? ""));
      const view = new URLSearchParams(search).get("view");
      return projectId.success && featureId.success
        ? {
            kind: "feature",
            projectId: projectId.data,
            featureId: featureId.data,
            ...(view === "plan" || view === "board" ? { view } : {}),
          }
        : { kind: "not_found" };
    }
    const proposalId = KestrelIdSchema.safeParse(new URLSearchParams(search).get("proposalId"));
    return projectId.success
      ? {
          kind: "project",
          projectId: projectId.data,
          ...(proposalId.success ? { proposalId: proposalId.data } : {}),
          ...(!proposalId.success && new URLSearchParams(search).get("view") === "pull_requests"
            ? { view: "pull_requests" as const }
            : {}),
        }
      : { kind: "not_found" };
  } catch {
    return { kind: "not_found" };
  }
}

export function appPath(route: Exclude<AppRoute, { kind: "not_found" }>): string {
  switch (route.kind) {
    case "planning":
      return `/projects/${encodeURIComponent(route.projectId)}/planning/${encodeURIComponent(route.requestId)}`;
    case "feature":
      return `/projects/${encodeURIComponent(route.projectId)}/features/${encodeURIComponent(route.featureId)}${route.view === undefined ? "" : `?view=${route.view}`}`;
    case "projects":
      return "/";
    case "settings":
      return `/settings${route.projectId === undefined ? "" : `?projectId=${encodeURIComponent(route.projectId)}`}`;
    case "project":
      return `/projects/${encodeURIComponent(route.projectId)}${route.proposalId === undefined ? (route.view === "pull_requests" ? "?view=pull_requests" : "") : `?proposalId=${encodeURIComponent(route.proposalId)}`}`;
  }
}
