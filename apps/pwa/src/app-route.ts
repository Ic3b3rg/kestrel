import { KestrelIdSchema } from "@kestrel/contracts";

export type AppRoute =
  | { kind: "not_found" }
  | { kind: "project"; projectId: string }
  | { kind: "projects" }
  | { kind: "settings" };

export function readAppRoute(pathname: string): AppRoute {
  if (pathname === "/") return { kind: "projects" };
  if (pathname === "/settings") return { kind: "settings" };
  const match = /^\/projects\/([^/]+)$/u.exec(pathname);
  if (match === null) return { kind: "not_found" };
  try {
    const projectId = KestrelIdSchema.safeParse(decodeURIComponent(match[1] ?? ""));
    return projectId.success
      ? { kind: "project", projectId: projectId.data }
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
      return "/settings";
    case "project":
      return `/projects/${encodeURIComponent(route.projectId)}`;
  }
}
