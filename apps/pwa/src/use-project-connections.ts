import { useCallback, useEffect, useState } from "react";

import type { ProjectInbox } from "@kestrel/contracts";

import {
  fetchCodexReviewModelPreference,
  fetchCodexSubscriptionConnection,
  fetchHostGitHubConnection,
} from "./api.js";

type Probe<T> = { state: "checking" } | { state: "unavailable" } | { state: "checked"; value: T };

function useProbe<T>(
  read: (signal: AbortSignal) => Promise<T>,
  enabled: boolean,
  refreshKey: string,
  onAuthenticationError?: (error: unknown) => boolean,
): Probe<T> {
  const [result, setResult] = useState<{ key: string; probe: Probe<T> } | null>(null);
  useEffect(() => {
    if (!enabled) {
      setResult(null);
      return;
    }
    const controller = new AbortController();
    setResult(null);
    void read(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) {
          setResult({ key: refreshKey, probe: { state: "checked", value } });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted && !(onAuthenticationError?.(error) ?? false)) {
          setResult({ key: refreshKey, probe: { state: "unavailable" } });
        }
      },
    );
    return () => controller.abort();
  }, [enabled, onAuthenticationError, read, refreshKey]);
  if (!enabled) return { state: "unavailable" };
  return result?.key === refreshKey ? result.probe : { state: "checking" };
}

export function useProjectConnections(
  project: ProjectInbox["projects"][number],
  online: boolean,
  onAuthenticationError?: (error: unknown) => boolean,
) {
  const [generation, setGeneration] = useState(0);
  const enabled =
    online &&
    (project.localRepositorySource?.state === "attached" ||
      project.changeProposals.some(({ kind }) => kind === "provider_observed"));
  const refreshKey = `${project.id}:${project.updatedAt}:${project.localRepositorySource?.state ?? "none"}:${String(generation)}`;
  const readGitHub = useCallback(
    (signal: AbortSignal) => fetchHostGitHubConnection(project.id, signal),
    [project.id],
  );
  const github = useProbe(readGitHub, enabled, refreshKey, onAuthenticationError);
  const codex = useProbe(
    fetchCodexSubscriptionConnection,
    enabled,
    refreshKey,
    onAuthenticationError,
  );
  const model = useProbe(
    fetchCodexReviewModelPreference,
    enabled,
    refreshKey,
    onAuthenticationError,
  );
  return { github, codex, model, refresh: () => setGeneration((value) => value + 1) };
}

export type ProjectConnections = ReturnType<typeof useProjectConnections>;
