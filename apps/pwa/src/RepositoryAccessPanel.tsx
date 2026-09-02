import { useCallback, useEffect, useRef, useState } from "react";

import type { LocalRepositoryInventory } from "@kestrel/contracts";

import { ApiClientError, fetchLocalRepositories } from "./api.js";
import { RepositorySetupState, TrustedHostRepositoryAction } from "./RepositorySetupState.js";

export interface RepositoryAccessPanelProps {
  loadRepositories?: (signal?: AbortSignal) => Promise<LocalRepositoryInventory>;
  onAuthenticationError?: (error: unknown) => boolean;
  online: boolean;
}

function safeError(error: unknown): string {
  if (error instanceof ApiClientError) {
    return `${error.details.message} Reference: ${error.details.correlationId}`;
  }
  return "Kestrel could not list authorized repositories.";
}

export function RepositoryAccessPanel({
  loadRepositories = fetchLocalRepositories,
  onAuthenticationError,
  online,
}: RepositoryAccessPanelProps) {
  const [inventory, setInventory] = useState<LocalRepositoryInventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!online) return;
    const controller = new AbortController();
    active.current?.abort();
    active.current = controller;
    setInventory(null);
    setError(null);
    setLoading(true);
    try {
      const result = await loadRepositories(controller.signal);
      if (active.current === controller && !controller.signal.aborted) {
        setInventory(result);
      }
    } catch (requestError) {
      if (
        !controller.signal.aborted &&
        active.current === controller &&
        !(onAuthenticationError?.(requestError) ?? false)
      ) {
        setError(safeError(requestError));
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setLoading(false);
      }
    }
  }, [loadRepositories, onAuthenticationError, online]);

  useEffect(() => {
    if (online) {
      void refresh();
    } else {
      active.current?.abort();
      active.current = null;
      setInventory(null);
      setError(null);
      setLoading(false);
    }
    return () => active.current?.abort();
  }, [online, refresh]);

  const setupState =
    loading || (inventory === null && error === null)
      ? "loading"
      : inventory?.inventoryState === "ready"
        ? null
        : (inventory?.inventoryState ?? "discovery_failed");

  return (
    <section className="repository-access" aria-labelledby="repository-settings-title">
      <div className="section-heading repository-access-heading">
        <div>
          <p className="section-index">04 / SETTINGS</p>
          <h2 id="repository-settings-title">Settings</h2>
        </div>
        <p className="credential-state">Paths stay on the trusted host</p>
      </div>
      <div className="repository-access-intro">
        <div>
          <h3>Repository access</h3>
          <p>
            Kestrel lists only repositories beneath explicitly authorized roots. Browser data uses
            bounded labels and opaque identities.
          </p>
        </div>
        <button
          className="secondary-action"
          type="button"
          disabled={!online || loading}
          onClick={() => void refresh()}
        >
          {loading ? "Refreshing repositories…" : "Refresh repositories"}
        </button>
      </div>

      {!online ? (
        <div className="repository-access-offline">
          <h3>Repository inventory hidden while offline</h3>
          <p>Kestrel will read trusted-host configuration after reconnection.</p>
        </div>
      ) : setupState === null ? (
        inventory?.inventoryState === "ready" ? (
          <>
            <ul className="repository-inventory">
              {inventory.repositories.map((repository) => (
                <li key={repository.repositoryId}>
                  <span>
                    <strong>{repository.displayName}</strong>
                    <small>
                      {repository.attachmentState === "attached" ? "Attached" : "Available to open"}
                    </small>
                  </span>
                  <code>{repository.repositoryId}</code>
                </li>
              ))}
            </ul>
            <TrustedHostRepositoryAction />
          </>
        ) : null
      ) : (
        <RepositorySetupState state={setupState} {...(error === null ? {} : { error })} />
      )}
    </section>
  );
}
