import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type {
  CodexSubscriptionConnection,
  CodexSubscriptionConnectionReason,
} from "@kestrel/contracts";

import { fetchCodexSubscriptionConnection } from "./api.js";

const remediation: Record<CodexSubscriptionConnectionReason, ReactNode> = {
  authentication_required: (
    <>
      Run <code>codex login</code> on this workstation with the intended ChatGPT account, then
      verify again.
    </>
  ),
  chatgpt_subscription_required: (
    <>
      Run <code>codex login</code> and choose ChatGPT sign-in; API-key and other provider modes are
      not the subscription route.
    </>
  ),
  cli_not_installed: (
    <>
      Run <code>npm install -g @openai/codex</code>, confirm <code>codex --version</code>, then
      verify again.
    </>
  ),
  cli_version_unsupported: (
    <>
      Run <code>npm install -g @openai/codex@latest</code>; Kestrel requires Codex CLI 0.152 or
      newer.
    </>
  ),
  protocol_unsupported: (
    <>
      Run <code>npm install -g @openai/codex@latest</code>, then verify the App Server handshake
      again.
    </>
  ),
  timed_out: "Confirm this workstation can reach the Codex service, then verify again.",
  unexpected_response: (
    <>
      Run <code>codex --version</code>, update Codex if needed, then verify again.
    </>
  ),
  usage_limit_reached:
    "Resolve the ChatGPT workspace usage or credit limit shown by Codex, then verify again.",
  waiting_for_usage_reset:
    "Codex reported a trustworthy usage reset window. Wait for that reset, then verify again.",
};

export interface CodexSubscriptionConnectionPanelProps {
  loadConnection?: (signal?: AbortSignal) => Promise<CodexSubscriptionConnection>;
  onAuthenticationError?: (error: unknown) => boolean;
  online: boolean;
}

function titleCase(value: string): string {
  const words = value.replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function formatReset(value: string | null): string | null {
  if (value === null) return null;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatUsageWindow(
  window: NonNullable<CodexSubscriptionConnection["usage"]>["primary"],
): string {
  if (window === null) return "Not reported";
  const reset = formatReset(window.resetsAt);
  return `${String(window.usedPercent)}% used${reset === null ? "" : ` · resets ${reset}`}`;
}

export function CodexSubscriptionConnectionPanel({
  loadConnection = fetchCodexSubscriptionConnection,
  onAuthenticationError,
  online,
}: CodexSubscriptionConnectionPanelProps) {
  const [connection, setConnection] = useState<CodexSubscriptionConnection | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef<AbortController | null>(null);

  const verify = useCallback(async () => {
    if (!online) return;
    const controller = new AbortController();
    active.current?.abort();
    active.current = controller;
    setConnection(null);
    setFailed(false);
    setLoading(true);
    try {
      const result = await loadConnection(controller.signal);
      if (active.current === controller && !controller.signal.aborted) setConnection(result);
    } catch (error) {
      if (
        active.current === controller &&
        !controller.signal.aborted &&
        !(onAuthenticationError?.(error) ?? false)
      ) {
        setFailed(true);
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setLoading(false);
      }
    }
  }, [loadConnection, onAuthenticationError, online]);

  useEffect(() => {
    if (online) {
      void verify();
    } else {
      active.current?.abort();
      active.current = null;
      setConnection(null);
      setFailed(false);
      setLoading(false);
    }
    return () => active.current?.abort();
  }, [online, verify]);

  const visibleState = !online || failed ? "unavailable" : loading ? "checking" : connection?.state;
  const stateLabel =
    visibleState === "ready"
      ? "Ready"
      : visibleState === "waiting_for_usage_reset"
        ? "Waiting for reset"
        : visibleState === "action_required"
          ? "Action required"
          : visibleState === "unavailable"
            ? "Unavailable"
            : "Checking";
  const cliLabel = !online
    ? "Not checked while offline"
    : failed
      ? "Probe unavailable"
      : connection?.cli === null
        ? "Not detected"
        : connection?.cli === undefined
          ? "Checking"
          : `Installed · ${connection.cli.version} · App Server v2`;
  const account = connection?.account;
  const defaultModel = connection?.models.find(({ isDefault }) => isDefault);
  const modelLabel =
    connection === null
      ? "Not checked"
      : connection.models.length === 0
        ? "No validated models"
        : `${defaultModel?.displayName ?? connection.models[0]?.displayName ?? "Available"} · ${String(connection.models.length)} available`;
  const usage = connection?.usage;
  const usageAvailability =
    usage === null || usage === undefined ? "Not checked" : titleCase(usage.availability);
  const recovery = !online
    ? "Reconnect this workstation, then verify the Codex connection again."
    : failed
      ? "Kestrel could not complete the bounded Codex App Server probe. Verify again."
      : connection?.reason === null || connection?.reason === undefined
        ? null
        : remediation[connection.reason];

  return (
    <section
      className="record-section codex-connection"
      aria-busy={loading}
      aria-labelledby="codex-connection-title"
    >
      <div className="section-heading">
        <div>
          <p className="section-index">03 / CONNECTIONS</p>
          <h2 id="codex-connection-title">Codex subscription</h2>
        </div>
        <p className={`state-marker connection-${visibleState ?? "checking"}`} role="status">
          <span aria-hidden="true" />
          {stateLabel}
        </p>
      </div>

      <div className="connection-controls connection-controls-single">
        <p>
          Starts a fresh local App Server probe. No review, thread, tool, or provider fallback is
          started.
        </p>
        <button
          className="secondary-action"
          type="button"
          disabled={!online || loading}
          onClick={() => void verify()}
        >
          Verify again
        </button>
      </div>

      <dl className="fact-list connection-facts">
        <div className="fact-wide">
          <dt>Codex CLI</dt>
          <dd>{cliLabel}</dd>
        </div>
        <div>
          <dt>Authentication</dt>
          <dd>{account === null || account === undefined ? "Not authenticated" : "ChatGPT"}</dd>
        </div>
        <div>
          <dt>Plan</dt>
          <dd>
            {account === null || account === undefined ? "Not available" : titleCase(account.plan)}
          </dd>
        </div>
        {account?.email === null || account?.email === undefined ? null : (
          <div className="fact-wide">
            <dt>Account</dt>
            <dd>{account.email}</dd>
          </div>
        )}
        <div>
          <dt>Models</dt>
          <dd>{modelLabel}</dd>
        </div>
        <div>
          <dt>Usage availability</dt>
          <dd>{usageAvailability}</dd>
        </div>
        {usage === null || usage === undefined ? null : (
          <>
            <div>
              <dt>Primary usage</dt>
              <dd>{formatUsageWindow(usage.primary)}</dd>
            </div>
            {usage.secondary === null ? null : (
              <div>
                <dt>Secondary usage</dt>
                <dd>{formatUsageWindow(usage.secondary)}</dd>
              </div>
            )}
          </>
        )}
        {connection === null ? null : (
          <div className="fact-wide">
            <dt>Last verified</dt>
            <dd>
              <time dateTime={connection.checkedAt}>
                {new Date(connection.checkedAt).toLocaleString()}
              </time>
            </dd>
          </div>
        )}
      </dl>

      {recovery === null ? (
        <p className="connection-note">
          Codex owns ChatGPT credential persistence and refresh; Kestrel stores no copied token.
        </p>
      ) : (
        <p className="connection-remediation">{recovery}</p>
      )}
    </section>
  );
}
