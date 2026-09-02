import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ChangeIntentVersionCreated,
  DirectApiProfile,
  InstallationEvent,
  InstallationSnapshot,
  LoginCommand,
  ProjectInbox,
  ProjectUpserted,
  ReviewRevisionAvailable,
  PublicGitHubPullRequestUrl,
  Session,
} from "@kestrel/contracts";

import {
  ApiClientError,
  fetchInstallation,
  fetchProjectInbox,
  fetchSession,
  loginOperator,
  logoutOperator,
  openPublicGitHubPullRequest,
  observeHostGitHubPullRequest,
  runDiagnostic,
  streamInstallationEvents,
  updateOperatorCredentials,
  type EventConnectionState,
} from "./api.js";
import { AuthenticatedShell, projectLabel } from "./AuthenticatedShell.js";
import { appPath, readAppRoute, type AppRoute } from "./app-route.js";
import { InstallationView, type PwaConnectionState } from "./InstallationView.js";
import { HostGitHubConnectionPanel } from "./HostGitHubConnectionPanel.js";
import { LoginView } from "./LoginView.js";
import { OpenProjectForm } from "./OpenProjectForm.js";
import {
  OperatorSecurityPanel,
  type OperatorCredentialFormValue,
} from "./OperatorSecurityPanel.js";
import { ProjectInboxPanel } from "./ProjectInboxPanel.js";
import { RepositoryAccessPanel } from "./RepositoryAccessPanel.js";

const INSTALLATION_ERROR_MESSAGE =
  "Kestrel could not read authoritative Installation data. Try again.";
const PROJECT_ERROR_MESSAGE = "Kestrel could not read the authoritative Project inbox. Try again.";
const SESSION_ERROR_MESSAGE = "Kestrel could not verify the Operator session. Try again.";

function newerSnapshot(
  current: InstallationSnapshot | null,
  candidate: InstallationSnapshot,
): InstallationSnapshot {
  if (
    current === null ||
    BigInt(candidate.installation.revision) >= BigInt(current.installation.revision)
  ) {
    return candidate;
  }
  return current;
}

function eventAnnouncement(event: InstallationEvent): string {
  switch (event.eventType) {
    case "installation.diagnostic.queued":
      return "Diagnostic queued.";
    case "installation.diagnostic.running":
      return "Diagnostic running.";
    case "installation.diagnostic.succeeded":
      return "Diagnostic succeeded.";
  }
}

function withUpsertedProject(
  current: ProjectInbox | null,
  project: ProjectUpserted["project"],
): ProjectInbox {
  const projects = current?.projects ?? [];
  const existingIndex = projects.findIndex((candidate) => candidate.id === project.id);
  if (existingIndex === -1) {
    return { schemaVersion: 1, projects: [...projects, project] };
  }
  return {
    schemaVersion: 1,
    projects: projects.map((candidate, index) => (index === existingIndex ? project : candidate)),
  };
}

function withCreatedIntent(
  current: ProjectInbox | null,
  result: ChangeIntentVersionCreated,
): ProjectInbox | null {
  if (current === null) return null;
  return {
    schemaVersion: 1,
    projects: current.projects.map((project) =>
      project.id !== result.projectId
        ? project
        : {
            ...project,
            changeProposals: project.changeProposals.map((proposal) =>
              proposal.id !== result.changeProposalId
                ? proposal
                : {
                    ...proposal,
                    changeIntent: result.changeIntent,
                    version: result.proposalVersion,
                  },
            ),
          },
    ),
  };
}

function withDirectApiProfile(
  current: ProjectInbox | null,
  projectId: string,
  profile: DirectApiProfile,
): ProjectInbox | null {
  if (current === null) return null;
  const modelAccess =
    profile.availability === "available"
      ? "direct_api_available"
      : profile.availability === "stale"
        ? "direct_api_stale"
        : "direct_api_unavailable";
  return {
    schemaVersion: 1,
    projects: current.projects.map((project) =>
      project.id === projectId ? { ...project, modelAccess } : project,
    ),
  };
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiClientError) {
    return `${error.details.message} Reference: ${error.details.correlationId}`;
  }
  return fallback;
}

function requiresAuthentication(error: unknown): boolean {
  return (
    error instanceof ApiClientError &&
    (error.details.code === "AUTHENTICATION_FAILED" ||
      error.details.code === "AUTHENTICATION_REQUIRED")
  );
}

function hasPendingChangeOverviewRendering(inbox: ProjectInbox | null): boolean {
  return (
    inbox?.projects.some((project) =>
      project.changeProposals.some((proposal) => {
        const overview = proposal.changeOverview;
        return (
          overview?.state === "ready" &&
          (overview.modelRendering.state === "queued" ||
            overview.modelRendering.state === "rendering")
        );
      }),
    ) ?? false
  );
}

export function App() {
  const [route, setRoute] = useState<AppRoute>(() => readAppRoute(window.location.pathname));
  const [online, setOnline] = useState(() => navigator.onLine);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [synchronized, setSynchronized] = useState(false);
  const [snapshot, setSnapshot] = useState<InstallationSnapshot | null>(null);
  const [connection, setConnection] = useState<PwaConnectionState>(() =>
    navigator.onLine ? "connecting" : "offline",
  );
  const [requestError, setRequestError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("Reading the Kestrel Installation.");
  const [commandPending, setCommandPending] = useState(false);
  const [securityPending, setSecurityPending] = useState<"credentials" | "logout" | null>(null);
  const [securityError, setSecurityError] = useState<string | null>(null);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const [projectInbox, setProjectInbox] = useState<ProjectInbox | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectPending, setProjectPending] = useState(false);
  const [projectReloadGeneration, setProjectReloadGeneration] = useState(0);
  const commandController = useRef<AbortController | null>(null);
  const loginController = useRef<AbortController | null>(null);
  const projectCommandController = useRef<AbortController | null>(null);
  const projectInboxController = useRef<AbortController | null>(null);
  const securityController = useRef<AbortController | null>(null);

  const navigate = useCallback((nextRoute: Exclude<AppRoute, { kind: "not_found" }>) => {
    const path = appPath(nextRoute);
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
    setRoute(nextRoute);
  }, []);

  useEffect(() => {
    const handlePopState = () => setRoute(readAppRoute(window.location.pathname));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const resetProjectState = useCallback(() => {
    projectInboxController.current?.abort();
    projectInboxController.current = null;
    setProjectInbox(null);
    setProjectLoading(false);
    setProjectPending(false);
    setProjectError(null);
  }, []);

  const requireAuthentication = useCallback(
    (message: string) => {
      commandController.current?.abort();
      projectCommandController.current?.abort();
      securityController.current?.abort();
      setSession(null);
      setSnapshot(null);
      resetProjectState();
      setSynchronized(false);
      setConnection("disconnected");
      setLoginError(message);
      setSecurityError(null);
    },
    [resetProjectState],
  );

  const handleAuthenticationBoundaryError = useCallback(
    (error: unknown): boolean => {
      if (!requiresAuthentication(error)) {
        return false;
      }
      requireAuthentication("The Operator session expired. Sign in again.");
      return true;
    },
    [requireAuthentication],
  );

  useEffect(() => {
    const handleOnline = () => {
      setOnline(true);
      setAnnouncement("Network restored. Refreshing the Installation.");
    };
    const handleOffline = () => {
      commandController.current?.abort();
      loginController.current?.abort();
      projectCommandController.current?.abort();
      securityController.current?.abort();
      setOnline(false);
      resetProjectState();
      setSynchronized(false);
      setConnection("offline");
      setAnnouncement("Offline. Installation data is hidden until Kestrel reconnects.");
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      commandController.current?.abort();
      loginController.current?.abort();
      projectCommandController.current?.abort();
      securityController.current?.abort();
    };
  }, [resetProjectState]);

  useEffect(() => {
    if (!online) {
      return;
    }
    const controller = new AbortController();
    let active = true;
    setSession(undefined);
    setLoginError(null);

    void fetchSession(controller.signal).then(
      (currentSession) => {
        if (active) {
          setSession(currentSession);
        }
      },
      (error: unknown) => {
        if (!active || controller.signal.aborted) {
          return;
        }
        setSession(null);
        if (!requiresAuthentication(error)) {
          setLoginError(errorMessage(error, SESSION_ERROR_MESSAGE));
        }
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [online]);

  useEffect(() => {
    if (!online || session === null || session === undefined) {
      return;
    }

    const controller = new AbortController();
    let active = true;
    let refreshQueue = Promise.resolve();

    const applySnapshot = (candidate: InstallationSnapshot) => {
      if (active) {
        setSnapshot((current) => newerSnapshot(current, candidate));
      }
    };

    const readAndApplySnapshot = async (): Promise<InstallationSnapshot> => {
      const candidate = await fetchInstallation(controller.signal);
      applySnapshot(candidate);
      return candidate;
    };

    const queueSnapshotRefresh = () => {
      refreshQueue = refreshQueue
        .then(async () => {
          await readAndApplySnapshot();
          if (active) {
            setSynchronized(true);
            setRequestError(null);
          }
        })
        .catch((error: unknown) => {
          if (active && !controller.signal.aborted) {
            if (!handleAuthenticationBoundaryError(error)) {
              setRequestError(errorMessage(error, INSTALLATION_ERROR_MESSAGE));
            }
          }
        });
    };

    const synchronize = async () => {
      setSynchronized(false);
      setRequestError(null);
      setConnection("connecting");

      try {
        const initial = await readAndApplySnapshot();
        if (!active) {
          return;
        }
        setSynchronized(true);
        setAnnouncement("Installation synchronized. Listening for durable events.");

        await streamInstallationEvents({
          after: initial.eventCursor,
          signal: controller.signal,
          onConnectionState(state: EventConnectionState) {
            if (active) {
              setConnection(state);
            }
          },
          async onCursorExpired() {
            if (active) {
              setSynchronized(false);
              setAnnouncement("Event history expired. Refreshing the full Installation.");
            }
            await refreshQueue;
            const refreshed = await readAndApplySnapshot();
            if (active) {
              setSynchronized(true);
              setRequestError(null);
              setAnnouncement("Installation refreshed from authoritative storage.");
            }
            return refreshed.eventCursor;
          },
          onEvent(event) {
            if (active) {
              setAnnouncement(eventAnnouncement(event));
              queueSnapshotRefresh();
            }
          },
        });
      } catch (error) {
        if (active && !controller.signal.aborted) {
          if (!handleAuthenticationBoundaryError(error)) {
            setConnection("disconnected");
            setRequestError(errorMessage(error, INSTALLATION_ERROR_MESSAGE));
          }
        }
      }
    };

    void synchronize();
    return () => {
      active = false;
      controller.abort();
    };
  }, [handleAuthenticationBoundaryError, online, reloadGeneration, session]);

  useEffect(() => {
    if (!online || session === null || session === undefined) {
      return;
    }

    const controller = new AbortController();
    let active = true;
    projectInboxController.current?.abort();
    projectInboxController.current = controller;
    setProjectLoading(true);
    setProjectError(null);

    void fetchProjectInbox(controller.signal).then(
      (inbox) => {
        if (!active || controller.signal.aborted || projectInboxController.current !== controller) {
          return;
        }
        projectInboxController.current = null;
        setProjectInbox(inbox);
        setProjectLoading(false);
      },
      (error: unknown) => {
        if (!active || controller.signal.aborted || projectInboxController.current !== controller) {
          return;
        }
        projectInboxController.current = null;
        setProjectLoading(false);
        if (!handleAuthenticationBoundaryError(error)) {
          setProjectError(errorMessage(error, PROJECT_ERROR_MESSAGE));
        }
      },
    );

    return () => {
      active = false;
      controller.abort();
      if (projectInboxController.current === controller) {
        projectInboxController.current = null;
      }
    };
  }, [handleAuthenticationBoundaryError, online, projectReloadGeneration, session]);

  useEffect(() => {
    if (
      !online ||
      session === null ||
      session === undefined ||
      projectLoading ||
      !hasPendingChangeOverviewRendering(projectInbox)
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      setProjectReloadGeneration((generation) => generation + 1);
    }, 1_000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [online, projectInbox, projectLoading, session]);

  const handleLogin = async (command: LoginCommand): Promise<void> => {
    const controller = new AbortController();
    loginController.current?.abort();
    loginController.current = controller;
    setLoginPending(true);
    setLoginError(null);
    try {
      const created = await loginOperator(command, controller.signal);
      setSession(created);
      setAnnouncement("Operator authenticated. Reading the Kestrel Installation.");
    } catch (error) {
      if (!controller.signal.aborted) {
        setLoginError(errorMessage(error, SESSION_ERROR_MESSAGE));
      }
    } finally {
      if (loginController.current === controller) {
        loginController.current = null;
        setLoginPending(false);
      }
    }
  };

  const handleRunDiagnostic = async () => {
    const controller = new AbortController();
    commandController.current?.abort();
    commandController.current = controller;
    setCommandPending(true);
    setRequestError(null);

    try {
      const accepted = await runDiagnostic(controller.signal);
      setSnapshot((current) => newerSnapshot(current, accepted));
      setAnnouncement("Diagnostic queued.");
    } catch (error) {
      if (!controller.signal.aborted) {
        if (!handleAuthenticationBoundaryError(error)) {
          setRequestError(errorMessage(error, INSTALLATION_ERROR_MESSAGE));
          setAnnouncement("The diagnostic request failed.");
        }
      }
    } finally {
      if (commandController.current === controller) {
        commandController.current = null;
        setCommandPending(false);
      }
    }
  };

  const handleOpenPublicPullRequest = async (url: PublicGitHubPullRequestUrl): Promise<void> => {
    const controller = new AbortController();
    projectCommandController.current?.abort();
    projectCommandController.current = controller;
    setProjectPending(true);
    setProjectError(null);

    try {
      const result = await openPublicGitHubPullRequest({ url }, controller.signal);
      setProjectInbox((current) => withUpsertedProject(current, result.project));
      navigate({ kind: "project", projectId: result.project.id });
      setAnnouncement("Project refreshed from the public GitHub pull request.");
    } catch (error) {
      if (!controller.signal.aborted) {
        if (!handleAuthenticationBoundaryError(error)) {
          setProjectError(errorMessage(error, PROJECT_ERROR_MESSAGE));
          setAnnouncement("The public pull request could not be opened.");
        }
      }
    } finally {
      if (projectCommandController.current === controller) {
        projectCommandController.current = null;
        setProjectPending(false);
      }
    }
  };

  const handleProjectOpened = (result: ProjectUpserted): void => {
    projectInboxController.current?.abort();
    projectInboxController.current = null;
    setProjectInbox((current) => withUpsertedProject(current, result.project));
    setProjectReloadGeneration((generation) => generation + 1);
    setProjectError(null);
    navigate({ kind: "project", projectId: result.project.id });
    setAnnouncement("Project opened from the authorized local repository.");
  };

  const handleLocalRevisionAvailable = (result: ReviewRevisionAvailable): void => {
    setProjectInbox((current) => withUpsertedProject(current, result.project));
    setProjectReloadGeneration((current) => current + 1);
    setProjectError(null);
    setAnnouncement("The exact Review Revision is available.");
  };

  const handleHostPullRequestRefresh = async (projectId: string, number: number): Promise<void> => {
    const controller = new AbortController();
    projectCommandController.current?.abort();
    projectCommandController.current = controller;
    setProjectPending(true);
    setProjectError(null);
    try {
      const result = await observeHostGitHubPullRequest(projectId, { number }, controller.signal);
      setProjectInbox((current) => withUpsertedProject(current, result.project));
      setAnnouncement("Project refreshed through the host GitHub session.");
    } catch (error) {
      if (!controller.signal.aborted && !handleAuthenticationBoundaryError(error)) {
        setProjectError(errorMessage(error, PROJECT_ERROR_MESSAGE));
      }
    } finally {
      if (projectCommandController.current === controller) {
        projectCommandController.current = null;
        setProjectPending(false);
      }
    }
  };

  const handleLogout = async (): Promise<void> => {
    const controller = new AbortController();
    projectCommandController.current?.abort();
    securityController.current?.abort();
    securityController.current = controller;
    setProjectPending(false);
    setSecurityPending("logout");
    setSecurityError(null);
    try {
      const outcome = await logoutOperator(controller.signal);
      setLoginError(
        outcome.auditError === null
          ? null
          : `This browser is signed out. ${outcome.auditError.message} Reference: ${outcome.auditError.correlationId}`,
      );
      setSession(null);
      setSnapshot(null);
      resetProjectState();
      setSynchronized(false);
      setConnection("disconnected");
    } catch (error) {
      if (!controller.signal.aborted && !handleAuthenticationBoundaryError(error)) {
        setSecurityError(errorMessage(error, "Kestrel could not sign out this browser."));
      }
    } finally {
      if (securityController.current === controller) {
        securityController.current = null;
        setSecurityPending(null);
      }
    }
  };

  const handleCredentialChange = async (value: OperatorCredentialFormValue): Promise<void> => {
    if (session === null || session === undefined) {
      return;
    }
    const controller = new AbortController();
    projectCommandController.current?.abort();
    securityController.current?.abort();
    securityController.current = controller;
    setProjectPending(false);
    setSecurityPending("credentials");
    setSecurityError(null);
    try {
      await updateOperatorCredentials({ ...value, session }, controller.signal);
      setLoginError(null);
      setSession(null);
      setSnapshot(null);
      resetProjectState();
      setSynchronized(false);
      setConnection("disconnected");
    } catch (error) {
      if (!controller.signal.aborted && !handleAuthenticationBoundaryError(error)) {
        setSecurityError(errorMessage(error, "Kestrel could not change the Operator credentials."));
      }
    } finally {
      if (securityController.current === controller) {
        securityController.current = null;
        setSecurityPending(null);
      }
    }
  };

  if (session === null || session === undefined) {
    return (
      <LoginView
        checking={session === undefined}
        error={loginError}
        online={online}
        pending={loginPending}
        onSubmit={handleLogin}
      />
    );
  }

  const selectedProject =
    route.kind === "project"
      ? (projectInbox?.projects.find((project) => project.id === route.projectId) ?? null)
      : null;
  const projectWorkspace =
    selectedProject === null ? null : (
      <div className="project-workspace">
        <header className="project-workspace-header">
          <p className="eyebrow">PROJECT / LOCAL WORKSPACE</p>
          <h1>{projectLabel(selectedProject)}</h1>
          <p className="lede">Repository context from one durable Project record.</p>
        </header>
        <ProjectInboxPanel
          error={null}
          inbox={{ schemaVersion: 1, projects: [selectedProject] }}
          loading={false}
          online={online}
          pending={projectPending}
          onAuthenticationError={handleAuthenticationBoundaryError}
          onOpen={(url) => void handleOpenPublicPullRequest(url)}
          onHostObserved={(project) => {
            setProjectInbox((current) => withUpsertedProject(current, project));
            setAnnouncement("Project refreshed through the host GitHub session.");
          }}
          onHostRefresh={(projectId, number) =>
            void handleHostPullRequestRefresh(projectId, number)
          }
          onIntentCreated={(result) => {
            setProjectInbox((current) => withCreatedIntent(current, result));
            setProjectReloadGeneration((generation) => generation + 1);
            setProjectError(null);
            setAnnouncement(
              `Change Intent version ${String(result.changeIntent.version)} created as ${result.changeIntent.resolution.state}.`,
            );
          }}
          onLocalAvailable={handleLocalRevisionAvailable}
          onModelProfileChanged={(projectId, profile) => {
            setProjectInbox((current) => withDirectApiProfile(current, projectId, profile));
            setProjectReloadGeneration((generation) => generation + 1);
            setAnnouncement(`Direct API profile ${profile.availability}.`);
          }}
          onRetry={() => setProjectReloadGeneration((generation) => generation + 1)}
        />
      </div>
    );
  const workspace = (() => {
    switch (route.kind) {
      case "projects":
        return (
          <section className="workspace-landing" aria-labelledby="workspace-title">
            <p className="eyebrow">LOCAL RUNTIME / PROJECTS</p>
            <h1 id="workspace-title">Projects</h1>
            <p className="lede">
              Open an authorized repository, then use the persistent rail to switch Project context.
            </p>
          </section>
        );
      case "settings":
        return (
          <InstallationView
            commandPending={commandPending}
            connection={connection}
            connectionControls={
              <HostGitHubConnectionPanel
                online={online}
                projects={projectInbox?.projects ?? []}
                onAuthenticationError={handleAuthenticationBoundaryError}
              />
            }
            loading={online && !synchronized && requestError === null}
            online={online}
            operatorControls={
              <OperatorSecurityPanel
                error={securityError}
                online={online}
                pending={securityPending}
                session={session}
                onChangeCredentials={handleCredentialChange}
                onLogout={handleLogout}
              />
            }
            repositoryControls={
              <RepositoryAccessPanel
                online={online}
                onAuthenticationError={handleAuthenticationBoundaryError}
              />
            }
            requestError={requestError}
            showData={online && synchronized}
            snapshot={snapshot}
            onRetry={() => setReloadGeneration((generation) => generation + 1)}
            onRunDiagnostic={() => void handleRunDiagnostic()}
          />
        );
      case "project":
        if (projectWorkspace !== null) return projectWorkspace;
        if (projectInbox === null && projectLoading) {
          return (
            <section className="workspace-state" aria-busy="true">
              <p className="section-index">PROJECT / SYNC</p>
              <h1>Reading selected Project</h1>
              <p>Waiting for the authoritative Project record.</p>
            </section>
          );
        }
        if (projectInbox === null) {
          return (
            <section className="workspace-state">
              <p className="section-index">PROJECT / UNAVAILABLE</p>
              <h1>Project unavailable</h1>
              <p>Retry the Project inventory from the navigation rail.</p>
            </section>
          );
        }
        return (
          <section className="workspace-state">
            <p className="section-index">PROJECT / NOT FOUND</p>
            <h1>Project not found</h1>
            <p>The URL does not identify a durable Project in this Installation.</p>
            <button type="button" onClick={() => navigate({ kind: "projects" })}>
              Back to Projects
            </button>
          </section>
        );
      case "not_found":
        return (
          <section className="workspace-state">
            <p className="section-index">ROUTE / NOT FOUND</p>
            <h1>Page not found</h1>
            <p>Use Projects or Settings to return to an authoritative workspace.</p>
            <button type="button" onClick={() => navigate({ kind: "projects" })}>
              Back to Projects
            </button>
          </section>
        );
    }
  })();

  return (
    <AuthenticatedShell
      announcement={announcement}
      connection={connection}
      error={projectError}
      inbox={projectInbox}
      loading={projectLoading}
      online={online}
      openProjectControl={
        <OpenProjectForm
          disabled={!online || projectPending}
          onAuthenticationError={handleAuthenticationBoundaryError}
          onOpened={handleProjectOpened}
        />
      }
      operatorUsername={session.operator.username}
      route={route}
      onNavigate={navigate}
      onRetry={() => setProjectReloadGeneration((generation) => generation + 1)}
    >
      {workspace}
    </AuthenticatedShell>
  );
}
