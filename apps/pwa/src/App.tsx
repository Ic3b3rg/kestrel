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
  runDiagnostic,
  streamInstallationEvents,
  type EventConnectionState,
} from "./api.js";
import { InstallationView, type PwaConnectionState } from "./InstallationView.js";
import { LoginView } from "./LoginView.js";

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

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    return `${error.details.message} Reference: ${error.details.correlationId}`;
  }
  return "Kestrel could not read authoritative Installation data. Try again.";
}

function authenticationErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    return `${error.details.message} Reference: ${error.details.correlationId}`;
  }
  return "Kestrel could not verify the Operator session. Try again.";
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
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const commandController = useRef<AbortController | null>(null);
  const loginController = useRef<AbortController | null>(null);

  const requireAuthentication = useCallback((message: string) => {
    commandController.current?.abort();
    setSession(null);
    setSnapshot(null);
    setSynchronized(false);
    setConnection("disconnected");
    setLoginError(message);
  }, []);

  useEffect(() => {
    const handleOnline = () => {
      setOnline(true);
      setAnnouncement("Network restored. Refreshing the Installation.");
    };
    const handleOffline = () => {
      commandController.current?.abort();
      loginController.current?.abort();
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
          setLoginError(authenticationErrorMessage(error));
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
            if (requiresAuthentication(error)) {
              requireAuthentication("The Operator session expired. Sign in again.");
            } else {
              setRequestError(errorMessage(error));
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
          if (requiresAuthentication(error)) {
            requireAuthentication("The Operator session expired. Sign in again.");
          } else {
            setConnection("disconnected");
            setRequestError(errorMessage(error));
          }
        }
      }
    };

    void synchronize();
    return () => {
      active = false;
      controller.abort();
    };
  }, [online, reloadGeneration, requireAuthentication, session]);

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
        setLoginError(authenticationErrorMessage(error));
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
        if (requiresAuthentication(error)) {
          requireAuthentication("The Operator session expired. Sign in again.");
        } else {
          setRequestError(errorMessage(error));
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
      operatorUsername={session.operator.username}
      requestError={requestError}
      showData={online && synchronized}
      snapshot={snapshot}
      onRetry={() => setReloadGeneration((generation) => generation + 1)}
      onRunDiagnostic={() => void handleRunDiagnostic()}
    />
  );
}
