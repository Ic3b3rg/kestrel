import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { FolderGit2, Layers3, LogOut, PanelLeft, Settings2, X } from "lucide-react";

import type { ProjectInbox } from "@kestrel/contracts";

import { Button } from "./components/ui/button.js";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from "./components/ui/sidebar.js";
import { TooltipProvider } from "./components/ui/tooltip.js";
import { FormFeedback } from "./components/FormFeedback.js";
import { appPath, type AppRoute } from "./app-route.js";

type NavigableRoute = Exclude<AppRoute, { kind: "not_found" }>;
type Project = ProjectInbox["projects"][number];

export interface AuthenticatedShellProps {
  announcement: string;
  children?: ReactNode;
  error: string | null;
  inbox: ProjectInbox | null;
  loading: boolean;
  logoutError: string | null;
  logoutPending: boolean;
  online: boolean;
  openProjectControl: ReactNode;
  route: AppRoute;
  onClearLogoutError?: () => void;
  onLogout: () => Promise<void>;
  onNavigate: (route: NavigableRoute) => void;
  onRetry: () => void;
  /** Project-scoped navigation, such as Planning Sessions, supplied by its owning feature. */
  projectNavigation?: ReactNode;
  projectFeatureIds?: Readonly<Record<string, string>>;
}

export function projectLabel(project: Project): string {
  if (project.repository !== null) {
    return `${project.repository.owner}/${project.repository.name}`;
  }
  return project.localRepositorySource?.displayName ?? `Project ${project.id.slice(0, 8)}`;
}

function shouldHandleNavigation(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.currentTarget.target !== "_blank"
  );
}

function WorkspaceShell(props: AuthenticatedShellProps) {
  const { openMobile, setOpenMobile } = useSidebar();
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const workspace = useRef<HTMLElement>(null);
  const routeWhenOpened = useRef(props.route);
  const logoutSubmission = useRef(false);
  useEffect(() => setOpenMobile(false), [props.route, setOpenMobile]);
  const currentProjectId =
    props.route.kind === "project" ||
    props.route.kind === "feature" ||
    props.route.kind === "planning" ||
    props.route.kind === "settings"
      ? props.route.projectId
      : undefined;
  const settingsRoute = {
    kind: "settings" as const,
    ...(currentProjectId === undefined ? {} : { projectId: currentProjectId }),
  };
  const navigate = (route: NavigableRoute) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!shouldHandleNavigation(event)) return;
    event.preventDefault();
    setOpenMobile(false);
    props.onNavigate(route);
  };
  const handleLogout = async () => {
    if (logoutSubmission.current || props.logoutPending || !props.online) return;
    props.onClearLogoutError?.();
    logoutSubmission.current = true;
    try {
      await props.onLogout();
    } finally {
      logoutSubmission.current = false;
    }
  };

  return (
    <>
      <Sidebar
        className="project-rail"
        aria-label="Workspace navigation"
        role="complementary"
        onMobileOpenAutoFocus={() => {
          routeWhenOpened.current = props.route;
        }}
        onMobileCloseAutoFocus={(event) => {
          event.preventDefault();
          const target =
            props.route !== routeWhenOpened.current ? workspace.current : navigationTrigger.current;
          target?.focus();
        }}
      >
        <SidebarHeader className="gap-5 px-4 pt-5 pb-3">
          <div className="flex items-center justify-between">
            <a className="wordmark wordmark-link" href="/" onClick={navigate({ kind: "projects" })}>
              <Layers3 className="size-5" aria-hidden="true" /> Kestrel
            </a>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Close navigation"
              onClick={() => setOpenMobile(false)}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
          {props.openProjectControl}
        </SidebarHeader>
        <SidebarContent className="project-rail-scroll px-2">
          <SidebarGroup>
            <SidebarGroupLabel>Projects</SidebarGroupLabel>
            <SidebarGroupContent>
              {props.error === null ? null : (
                <div className="project-rail-state project-rail-error" role="alert">
                  <p>{props.error}</p>
                  <Button variant="outline" disabled={!props.online} onClick={props.onRetry}>
                    Retry Projects
                  </Button>
                </div>
              )}
              {!props.online ? (
                <div className="project-rail-state">
                  <strong>Projects hidden offline</strong>
                  <span>Reconnect to view your Projects.</span>
                </div>
              ) : props.loading && props.inbox === null ? (
                <div className="project-rail-state" aria-busy="true">
                  <strong>Reading Projects</strong>
                  <span>Your Projects will appear here.</span>
                </div>
              ) : props.inbox?.projects.length === 0 ? (
                <div className="project-rail-state">
                  <strong>No Projects yet</strong>
                  <span>Open a repository to get started.</span>
                </div>
              ) : null}
              {props.inbox !== null && props.inbox.projects.length > 0 ? (
                <nav aria-label="Projects">
                  <SidebarMenu>
                    {props.inbox.projects.map((project) => {
                      const selected = currentProjectId === project.id;
                      const projectRoute: NavigableRoute = {
                        kind: "project",
                        projectId: project.id,
                      };
                      return (
                        <SidebarMenuItem key={project.id}>
                          <SidebarMenuButton
                            asChild
                            isActive={selected}
                            className="h-auto min-h-11 py-2"
                          >
                            <a
                              href={appPath(projectRoute)}
                              aria-current={
                                selected && props.route.kind === "project" ? "page" : undefined
                              }
                              onClick={navigate(projectRoute)}
                            >
                              <FolderGit2 aria-hidden="true" className="text-muted-foreground" />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate">{projectLabel(project)}</span>
                                <span className="block text-xs font-normal text-muted-foreground">
                                  {project.localRepositorySource?.state === "attached"
                                    ? "Local source attached"
                                    : "Connect local source"}
                                </span>
                              </span>
                              {selected ? <span className="sr-only">Selected Project</span> : null}
                            </a>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                  {props.loading ? (
                    <p className="project-rail-state">Refreshing Projects…</p>
                  ) : null}
                </nav>
              ) : null}
            </SidebarGroupContent>
          </SidebarGroup>
          {currentProjectId === undefined ? null : props.projectNavigation}
        </SidebarContent>
        <SidebarFooter className="gap-2 border-t border-sidebar-border p-4">
          <nav aria-label="Installation">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={props.route.kind === "settings"}
                  className="h-10"
                >
                  <a
                    href={appPath(settingsRoute)}
                    aria-current={props.route.kind === "settings" ? "page" : undefined}
                    onClick={navigate(settingsRoute)}
                  >
                    <Settings2 aria-hidden="true" /> Settings
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="h-10"
                  disabled={!props.online || props.logoutPending}
                  type="button"
                  onClick={() => void handleLogout()}
                >
                  <LogOut aria-hidden="true" />
                  {props.logoutPending ? "Signing out…" : "Sign out"}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </nav>
          {props.logoutPending ? (
            <FormFeedback kind="pending" visuallyHidden>
              Signing out…
            </FormFeedback>
          ) : props.logoutError === null ? null : (
            <FormFeedback focus kind="error" title="Sign-out failed">
              {props.logoutError}
            </FormFeedback>
          )}
        </SidebarFooter>
      </Sidebar>
      <div className="workspace-frame">
        <header className="mobile-workspace-header md:hidden">
          <Button
            ref={navigationTrigger}
            variant="ghost"
            size="icon"
            aria-label="Open navigation"
            aria-expanded={openMobile}
            onClick={() => setOpenMobile(true)}
          >
            <PanelLeft aria-hidden="true" />
          </Button>
          <span>Kestrel</span>
        </header>
        <main ref={workspace} className="shell-workspace" id="workspace" tabIndex={-1}>
          {props.children}
          <p className="activity-line" role="status" aria-live="polite" aria-atomic="true">
            {props.announcement}
          </p>
        </main>
      </div>
    </>
  );
}

export function AuthenticatedShell(props: AuthenticatedShellProps) {
  return (
    <>
      <a className="skip-link" href="#workspace">
        Skip to workspace
      </a>
      <TooltipProvider>
        <SidebarProvider open className="authenticated-shell">
          <WorkspaceShell {...props} />
        </SidebarProvider>
      </TooltipProvider>
    </>
  );
}
