import { useEffect, useRef, useState, type SyntheticEvent } from "react";

import type { Session } from "@kestrel/contracts";

const sessionExpiryFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
});

export interface OperatorCredentialFormValue {
  currentPassword: string;
  newPassword: string;
  username: string;
}

interface OperatorSecurityPanelProps {
  error: string | null;
  online: boolean;
  onChangeCredentials(value: OperatorCredentialFormValue): Promise<void>;
  onLogout(): Promise<void>;
  pending: "credentials" | "logout" | null;
  session: Session;
}

function clearPasswordFields(form: HTMLFormElement): void {
  for (const name of ["currentPassword", "newPassword", "newPasswordConfirmation"]) {
    const input = form.elements.namedItem(name);
    if (input instanceof HTMLInputElement) {
      input.value = "";
    }
  }
}

export function OperatorSecurityPanel(props: OperatorSecurityPanelProps) {
  const [validationError, setValidationError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const visibleError = validationError ?? props.error;

  useEffect(() => {
    if (visibleError) {
      errorRef.current?.focus();
    }
  }, [visibleError]);

  const handleSubmit = async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = data.get("currentPassword");
    const newPassword = data.get("newPassword");
    const confirmation = data.get("newPasswordConfirmation");
    const username = data.get("username");
    setValidationError(null);

    if (
      typeof newPassword !== "string" ||
      typeof confirmation !== "string" ||
      newPassword !== confirmation
    ) {
      setValidationError("The new password confirmation does not match.");
      clearPasswordFields(form);
      return;
    }

    try {
      await props.onChangeCredentials({
        currentPassword: typeof currentPassword === "string" ? currentPassword : "",
        newPassword,
        username: typeof username === "string" ? username : "",
      });
    } finally {
      clearPasswordFields(form);
    }
  };

  const controlsDisabled = !props.online || props.pending !== null;
  return (
    <section className="operator-security" aria-labelledby="operator-security-title">
      <div className="section-heading">
        <div>
          <p className="section-index">05 / OPERATOR</p>
          <h2 id="operator-security-title">Operator security</h2>
        </div>
        <p className="security-state">Step-up protected</p>
      </div>

      <div className="security-layout">
        <div className="security-session">
          <h3>Current session</h3>
          <dl className="security-facts">
            <div>
              <dt>Username</dt>
              <dd>{props.session.operator.username}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>
                <time dateTime={props.session.expiresAt}>
                  {sessionExpiryFormatter.format(new Date(props.session.expiresAt))}
                </time>
              </dd>
            </div>
          </dl>
          <button
            className="secondary-action"
            type="button"
            disabled={controlsDisabled}
            onClick={() => void props.onLogout()}
          >
            {props.pending === "logout" ? "Signing out…" : "Sign out"}
          </button>
          <p className="form-help">Clears only this browser’s authentication cookies.</p>
        </div>

        <form
          className="security-form"
          aria-busy={props.pending === "credentials"}
          onSubmit={(event) => void handleSubmit(event)}
        >
          <div>
            <h3>Change credentials</h3>
            <p className="required-note">All fields are required.</p>
          </div>
          <div className="form-field">
            <label htmlFor="operator-current-password">Current password</label>
            <input
              autoComplete="current-password"
              id="operator-current-password"
              maxLength={128}
              name="currentPassword"
              required
              type="password"
            />
          </div>
          <div className="form-field">
            <label htmlFor="operator-username">Operator username</label>
            <input
              autoComplete="username"
              defaultValue={props.session.operator.username}
              id="operator-username"
              maxLength={64}
              name="username"
              pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
              required
              type="text"
            />
          </div>
          <div className="form-field">
            <label htmlFor="operator-new-password">New password</label>
            <input
              autoComplete="new-password"
              id="operator-new-password"
              maxLength={128}
              minLength={12}
              name="newPassword"
              required
              type="password"
            />
          </div>
          <div className="form-field">
            <label htmlFor="operator-new-password-confirmation">Confirm new password</label>
            <input
              aria-describedby={validationError ? "operator-security-error" : undefined}
              aria-invalid={validationError !== null}
              autoComplete="new-password"
              id="operator-new-password-confirmation"
              maxLength={128}
              minLength={12}
              name="newPasswordConfirmation"
              required
              type="password"
            />
          </div>
          {visibleError ? (
            <div
              className="security-error"
              id="operator-security-error"
              ref={errorRef}
              role="alert"
              tabIndex={-1}
            >
              <strong>Security action failed</strong>
              <span>{visibleError}</span>
            </div>
          ) : null}
          <button type="submit" disabled={controlsDisabled}>
            {props.pending === "credentials"
              ? "Changing credentials…"
              : "Change credentials and sign out"}
          </button>
          <p className="form-help">
            Verifies the current password, then invalidates every signed-in device.
          </p>
        </form>
      </div>
    </section>
  );
}
