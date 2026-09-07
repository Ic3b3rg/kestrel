import { Button } from "./components/ui/button.js";
import { FeatureNavigation } from "./FeatureNavigation.js";
import { FeatureChatPanel } from "./FeatureChatPanel.js";
import { readFeatureNavigation, saveFeatureNavigation } from "./feature-navigation.js";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  Feature,
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
import { ProjectSettingsPanel } from "./ProjectSettingsPanel.js";
import { AuthenticatedShell, projectLabel } from "./AuthenticatedShell.js";
import { appPath, readAppRoute, type AppRoute } from "./app-route.js";
import { InstallationView, type PwaConnectionState } from "./InstallationView.js";
import { CodexSubscriptionConnectionPanel } from "./CodexSubscriptionConnectionPanel.js";
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

function readHistoryPosition(state: unknown): number | null {
  return typeof state === "object" &&
    state !== null &&
    "kestrelPosition" in state &&
    typeof state.kestrelPosition === "number" &&
    Number.isSafeInteger(state.kestrelPosition) &&
    state.kestrelPosition >= 0
    ? state.kestrelPosition
    : null;
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
  const [projectFeatureIds, setProjectFeatureIds] = useState(readFeatureNavigation);
  const [planDirty, setPlanDirty] = useState(false);
  const [route, setRoute] = useState<AppRoute>(() =>
    readAppRoute(window.location.pathname, window.location.search),
  );
  const [networkOnline, setNetworkOnline] = useState(() => navigator.onLine);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [sessionChecking, setSessionChecking] = useState(true);
  const [sessionCheckError, setSessionCheckError] = useState<string | null>(null);
  const [sessionCheckGeneration, setSessionCheckGeneration] = useState(0);
  const online = networkOnline && !sessionChecking && sessionCheckError === null;
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
  const historyPosition = useRef(readHistoryPosition(window.history.state) ?? 0);
  const restoringHistory = useRef(false);

  useEffect(() => {
    window.history.replaceState({ kestrelPosition: historyPosition.current }, "");
  }, []);

  useEffect(() => {
    saveFeatureNavigation(projectFeatureIds);
  }, [projectFeatureIds]);
  useEffect(() => {
    if (session === null)
      setProjectFeatureIds((current) => (Object.keys(current).length === 0 ? current : {}));
  }, [session]);
  const rememberFeature = useCallback(
    (feature: Feature) => {
      const aliasedProject =
        route.kind === "feature" &&
        route.featureId === feature.id &&
        route.projectId !== feature.projectId;
      setProjectFeatureIds((current) => {
        if (!aliasedProject && current[feature.projectId] === feature.id) return current;
        const retained = aliasedProject
          ? Object.fromEntries(Object.entries(current).filter(([id]) => id !== route.projectId))
          : current;
        return { ...retained, [feature.projectId]: feature.id };
      });
      if (aliasedProject) {
        const canonicalRoute = {
          kind: "feature" as const,
          projectId: feature.projectId,
          featureId: feature.id,
          ...(route.view === undefined ? {} : { view: route.view }),
        };
        window.history.replaceState(window.history.state, "", appPath(canonicalRoute));
        setRoute(canonicalRoute);
      }
    },
    [route],
  );
  const forgetFeature = useCallback((projectId: string, featureId: string) => {
    setProjectFeatureIds((current) =>
      current[projectId] !== featureId
        ? current
        : Object.fromEntries(Object.entries(current).filter(([id]) => id !== projectId)),
    );
  }, []);

  const navigate = useCallback(
    (nextRoute: Exclude<AppRoute, { kind: "not_found" }>) => {
      const sameFeature =
        route.kind === "feature" &&
        nextRoute.kind === "feature" &&
        route.projectId === nextRoute.projectId &&
        route.featureId === nextRoute.featureId;
      if (
        planDirty &&
        !sameFeature &&
        !window.confirm("Discard unsaved plan edits and leave this feature?")
      )
        return;
      const path = appPath(nextRoute);
      if (`${window.location.pathname}${window.location.search}` !== path) {
        historyPosition.current += 1;
        window.history.pushState({ kestrelPosition: historyPosition.current }, "", path);
      }
      setRoute(nextRoute);
    },
    [planDirty, route],
  );

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (restoringHistory.current) {
        restoringHistory.current = false;
        return;
      }
      // Native fragment navigation creates an entry without an application position.
      const nextPosition = readHistoryPosition(event.state) ?? historyPosition.current + 1;
      const nextRoute = readAppRoute(window.location.pathname, window.location.search);
      const sameFeature =
        route.kind === "feature" &&
        nextRoute.kind === "feature" &&
        route.projectId === nextRoute.projectId &&
        route.featureId === nextRoute.featureId;
      if (
        planDirty &&
        route.kind !== "not_found" &&
        !sameFeature &&
        !window.confirm("Discard unsaved plan edits and leave this feature?")
      ) {
        restoringHistory.current = true;
        window.history.go(historyPosition.current - nextPosition);
        return;
      }
      historyPosition.current = nextPosition;
      if (readHistoryPosition(event.state) === null)
        window.history.replaceState({ kestrelPosition: nextPosition }, "");
      setRoute(nextRoute);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [planDirty, route]);

  useEffect(() => {
    if (!planDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [planDirty]);

  useEffect(() => {
    if (route.kind !== "settings" || session == null) return;
    const target = document.getElementById(window.location.hash.slice(1));
    if (target === null) return;
    target.focus();
    const revealTarget = () => {
      if (document.activeElement === target) target.scrollIntoView({ block: "start" });
    };
    revealTarget();
    // Connection facts arrive asynchronously above the linked section. Keep the requested
    // heading visible until the Operator takes over navigation.
    const observer = new ResizeObserver(revealTarget);
    observer.observe(target.closest(".settings-view") ?? target);
    const stopFollowing = () => observer.disconnect();
    const navigationEvents = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const event of navigationEvents) {
      window.addEventListener(event, stopFollowing, { once: true, passive: true });
    }
    return () => {
      observer.disconnect();
      for (const event of navigationEvents) window.removeEventListener(event, stopFollowing);
    };
  }, [route, session]);

  const resetProjectState = useCallback(() => {
    projectInboxController.current?.abort();
    projectInboxController.current = null;
    setProjectInbox(null);
    setProjectLoading(false);
    setProjectPending(false);
    setProjectError(null);
  }, []);

  const requireAuthentication = useCallback(
    (message: string | null) => {
      commandController.current?.abort();
      projectCommandController.current?.abort();
      securityController.current?.abort();
      setSession(null);
      setSessionChecking(false);
      setSessionCheckError(null);
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
      setSessionChecking(true);
      setNetworkOnline(true);
      setAnnouncement("Network restored. Refreshing the Installation.");
    };
    const handleOffline = () => {
      commandController.current?.abort();
      loginController.current?.abort();
      projectCommandController.current?.abort();
      securityController.current?.abort();
      setNetworkOnline(false);
      setSessionChecking(true);
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
    if (!networkOnline) {
      return;
    }
    const controller = new AbortController();
    let active = true;
    setSessionChecking(true);
    setSessionCheckError(null);
    setLoginError(null);

    void fetchSession(controller.signal).then(
      (currentSession) => {
        if (active) {
          setSession(currentSession);
          setSessionChecking(false);
        }
      },
      (error: unknown) => {
        if (!active || controller.signal.aborted) {
          return;
        }
        if (requiresAuthentication(error)) requireAuthentication(null);
        else setSessionCheckError(errorMessage(error, SESSION_ERROR_MESSAGE));
        setSessionChecking(false);
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [networkOnline, sessionCheckGeneration, requireAuthentication]);

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
      setSessionChecking(false);
      setSessionCheckError(null);
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
      const number = Number(new URL(url).pathname.split("/").at(-1));
      const proposal = result.project.changeProposals.find(
        (candidate) => candidate.kind === "provider_observed" && candidate.number === number,
      );
      navigate({
        kind: "project",
        projectId: result.project.id,
        ...(proposal === undefined ? {} : { proposalId: proposal.id }),
      });
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
    navigate({
      kind: "project",
      projectId: result.project.id,
      ...(route.kind === "project" &&
      route.projectId === result.project.id &&
      route.proposalId !== undefined
        ? { proposalId: route.proposalId }
        : {}),
    });
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
        checking={sessionChecking}
        error={loginError ?? sessionCheckError}
        online={networkOnline}
        pending={loginPending}
        onSubmit={handleLogin}
      />
    );
  }

  const selectedProject =
    route.kind === "project" || route.kind === "feature"
      ? (projectInbox?.projects.find((project) => project.id === route.projectId) ?? null)
      : null;
  const navigationProjectId = "projectId" in route ? route.projectId : undefined;
  const navigationProject = projectInbox?.projects.find(({ id }) => id === navigationProjectId);
  const projectWorkspace =
    selectedProject === null ? null : (
      <ProjectInboxPanel
        key={selectedProject.id}
        selectedProposalId={route.kind === "project" ? (route.proposalId ?? "") : ""}
        onSelectProposal={(proposalId) =>
          navigate({
            kind: "project",
            projectId: selectedProject.id,
            ...(proposalId === null ? {} : { proposalId }),
          })
        }
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
        onHostRefresh={(projectId, number) => void handleHostPullRequestRefresh(projectId, number)}
        onIntentCreated={(result) => {
          setProjectInbox((current) => withCreatedIntent(current, result));
          setProjectReloadGeneration((generation) => generation + 1);
          setProjectError(null);
          setAnnouncement(
            `Change Intent version ${String(result.changeIntent.version)} created as ${result.changeIntent.resolution.state}.`,
          );
        }}
        onLocalAvailable={handleLocalRevisionAvailable}
        onProjectOpened={handleProjectOpened}
        onRetry={() => setProjectReloadGeneration((generation) => generation + 1)}
      />
    );
  const workspace = (() => {
    switch (route.kind) {
      case "projects":
        return (
          <section className="workspace-landing" aria-labelledby="workspace-title">
            <h1 id="workspace-title">Projects</h1>
            <p className="lede">
              Select a Project in the sidebar, or open a repository to get started.
            </p>
          </section>
        );
      case "settings":
        return (
          <InstallationView
            commandPending={commandPending}
            connection={connection}
            connectionControls={
              <>
                <HostGitHubConnectionPanel
                  initialProjectId={route.projectId ?? ""}
                  online={online}
                  projects={projectInbox?.projects ?? []}
                  onAuthenticationError={handleAuthenticationBoundaryError}
                />
                <CodexSubscriptionConnectionPanel
                  online={online}
                  onAuthenticationError={handleAuthenticationBoundaryError}
                />
                <ProjectSettingsPanel
                  projects={projectInbox?.projects ?? []}
                  projectId={route.projectId ?? ""}
                  onSelectProject={(projectId) =>
                    navigate({ kind: "settings", ...(projectId === "" ? {} : { projectId }) })
                  }
                  online={online}
                  onAuthenticationError={handleAuthenticationBoundaryError}
                  onChanged={(projectId, profile) => {
                    setProjectInbox((current) => withDirectApiProfile(current, projectId, profile));
                    setProjectReloadGeneration((generation) => generation + 1);
                    setAnnouncement(`Direct API profile ${profile.availability}.`);
                  }}
                />
              </>
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
              <h1>Reading selected Project</h1>
              <p>Loading your Project…</p>
            </section>
          );
        }
        if (projectInbox === null) {
          return (
            <section className="workspace-state">
              <h1>Project unavailable</h1>
              <p>Reconnect or retry Projects in the sidebar.</p>
            </section>
          );
        }
        return (
          <section className="workspace-state">
            <h1>Project not found</h1>
            <p>This Project could not be found. Choose another Project in the sidebar.</p>
            <Button type="button" onClick={() => navigate({ kind: "projects" })}>
              Back to Projects
            </Button>
          </section>
        );
      case "feature":
        return (
          <FeatureChatPanel
            key={`${route.projectId}/${route.featureId}`}
            projectId={route.projectId}
            projectName={
              navigationProject === undefined ? "Project" : projectLabel(navigationProject)
            }
            featureId={route.featureId}
            {...(route.view === undefined ? {} : { view: route.view })}
            onPlanDirtyChange={setPlanDirty}
            online={online}
            onNavigate={navigate}
            onAuthenticationError={handleAuthenticationBoundaryError}
            onFeatureRead={rememberFeature}
            onFeatureUnavailable={forgetFeature}
          />
        );
      case "not_found":
        return (
          <section className="workspace-state">
            <h1>Page not found</h1>
            <p>Choose Projects or Settings in the sidebar to continue.</p>
            <Button type="button" onClick={() => navigate({ kind: "projects" })}>
              Back to Projects
            </Button>
          </section>
        );
    }
  })();

  const sessionPaused = networkOnline && (sessionChecking || sessionCheckError !== null);
  return (
    <>
      {sessionPaused ? (
        <main className="login-main">
          <section className="system-state" aria-busy={sessionChecking}>
            <h1>{sessionChecking ? "Checking Operator session" : "Session check unavailable"}</h1>
            <p>
              Your unsaved edits are retained. The workspace resumes after session verification.
            </p>
            {sessionCheckError === null ? null : (
              <>
                <p role="alert">{sessionCheckError}</p>
                <Button onClick={() => setSessionCheckGeneration((current) => current + 1)}>
                  Retry session check
                </Button>
              </>
            )}
          </section>
        </main>
      ) : null}
      <div hidden={sessionPaused}>
        <AuthenticatedShell
          key={`${session.operator.id}/${session.credentialVersion}/${session.issuedAt}`}
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
          projectFeatureIds={projectFeatureIds}
          projectNavigation={
            navigationProject === undefined ? null : (
              <FeatureNavigation
                key={navigationProject.id}
                projectId={navigationProject.id}
                {...(route.kind === "feature" ? { selectedFeatureId: route.featureId } : {})}
                online={online}
                onNavigate={navigate}
                onAuthenticationError={handleAuthenticationBoundaryError}
              />
            )
          }
          onNavigate={navigate}
          onRetry={() => setProjectReloadGeneration((generation) => generation + 1)}
        >
          {workspace}
        </AuthenticatedShell>
      </div>
    </>
  );
}
