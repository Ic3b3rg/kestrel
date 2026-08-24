import { useEffect, useRef, useState } from "react";

import type { InstallationEvent, InstallationSnapshot } from "@kestrel/contracts";

import {
  ApiClientError,
  fetchInstallation,
  runDiagnostic,
  streamInstallationEvents,
  type EventConnectionState,
} from "./api.js";
import { InstallationView, type PwaConnectionState } from "./InstallationView.js";

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

export function App() {
  const [online, setOnline] = useState(() => navigator.onLine);
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

  useEffect(() => {
    const handleOnline = () => {
      setOnline(true);
      setAnnouncement("Network restored. Refreshing the Installation.");
    };
    const handleOffline = () => {
      commandController.current?.abort();
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
    };
  }, []);

  useEffect(() => {
    if (!online) {
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
            setRequestError(errorMessage(error));
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
          setConnection("disconnected");
          setRequestError(errorMessage(error));
        }
      }
    };

    void synchronize();
    return () => {
      active = false;
      controller.abort();
    };
  }, [online, reloadGeneration]);

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
        setRequestError(errorMessage(error));
        setAnnouncement("The diagnostic request failed.");
      }
    } finally {
      if (commandController.current === controller) {
        commandController.current = null;
        setCommandPending(false);
      }
    }
  };

  return (
    <InstallationView
      announcement={announcement}
      commandPending={commandPending}
      connection={connection}
      loading={online && !synchronized && requestError === null}
      online={online}
      requestError={requestError}
      showData={online && synchronized}
      snapshot={snapshot}
      onRetry={() => setReloadGeneration((generation) => generation + 1)}
      onRunDiagnostic={() => void handleRunDiagnostic()}
    />
  );
}
