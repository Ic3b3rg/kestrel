import { useCallback, useEffect, useRef, useState } from "react";

import type {
  InstallationEvent,
  InstallationSnapshot,
  LoginCommand,
  Session,
} from "@kestrel/contracts";

import {
  ApiClientError,
  fetchInstallation,
  fetchSession,
  loginOperator,
  logoutOperator,
  runDiagnostic,
  streamInstallationEvents,
  updateOperatorCredentials,
  type EventConnectionState,
} from "./api.js";
import { InstallationView, type PwaConnectionState } from "./InstallationView.js";
import { LoginView } from "./LoginView.js";
import {
  OperatorSecurityPanel,
  type OperatorCredentialFormValue,
} from "./OperatorSecurityPanel.js";

const INSTALLATION_ERROR_MESSAGE =
  "Kestrel could not read authoritative Installation data. Try again.";
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

export function App() {
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
  const commandController = useRef<AbortController | null>(null);
  const loginController = useRef<AbortController | null>(null);
  const securityController = useRef<AbortController | null>(null);

  const requireAuthentication = useCallback((message: string) => {
    commandController.current?.abort();
    securityController.current?.abort();
    setSession(null);
    setSnapshot(null);
    setSynchronized(false);
    setConnection("disconnected");
    setLoginError(message);
    setSecurityError(null);
  }, []);

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
      securityController.current?.abort();
      setOnline(false);
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
      securityController.current?.abort();
    };
  }, []);

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

  const handleLogout = async (): Promise<void> => {
    const controller = new AbortController();
    securityController.current?.abort();
    securityController.current = controller;
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
    securityController.current?.abort();
    securityController.current = controller;
    setSecurityPending("credentials");
    setSecurityError(null);
    try {
      await updateOperatorCredentials({ ...value, session }, controller.signal);
      setLoginError(null);
      setSession(null);
      setSnapshot(null);
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

  return (
    <InstallationView
      announcement={announcement}
      commandPending={commandPending}
      connection={connection}
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
      operatorUsername={session.operator.username}
      requestError={requestError}
      showData={online && synchronized}
      snapshot={snapshot}
      onRetry={() => setReloadGeneration((generation) => generation + 1)}
      onRunDiagnostic={() => void handleRunDiagnostic()}
    />
  );
}
