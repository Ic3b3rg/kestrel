import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Label } from "./components/ui/label.js";
import { FormFeedback, FormFieldError } from "./components/FormFeedback.js";
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

export interface OperatorSecurityError {
  action: "credentials" | "logout";
  message: string;
}

type CredentialField = "currentPassword" | "newPassword" | "newPasswordConfirmation" | "username";

interface ValidationFocusRequest {
  field: CredentialField;
  message: string;
}

const credentialFieldOrder = [
  "currentPassword",
  "username",
  "newPassword",
  "newPasswordConfirmation",
] as const;

interface OperatorSecurityPanelProps {
  error: OperatorSecurityError | null;
  online: boolean;
  onChangeCredentials(value: OperatorCredentialFormValue): Promise<void>;
  onClearError?(): void;
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
  const formRef = useRef<HTMLFormElement>(null);
  const credentialSubmission = useRef(false);
  const [validationErrors, setValidationErrors] = useState<
    Partial<Record<CredentialField, string>>
  >({});
  const [validationFocusRequest, setValidationFocusRequest] =
    useState<ValidationFocusRequest | null>(null);
  const firstInvalidField = credentialFieldOrder.find(
    (name) => validationErrors[name] !== undefined,
  );
  const credentialError = props.error?.action === "credentials" ? props.error.message : null;

  useEffect(() => {
    if (validationFocusRequest === null) return;
    const input = formRef.current?.elements.namedItem(validationFocusRequest.field);
    if (input instanceof HTMLInputElement) input.focus();
  }, [validationFocusRequest]);

  const clearValidationError = (name: CredentialField) => {
    setValidationFocusRequest(null);
    setValidationErrors((current) => {
      if (current[name] === undefined) return current;
      const { [name]: removed, ...next } = current;
      void removed;
      return next;
    });
  };

  const handleSubmit = async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    if (credentialSubmission.current || props.pending !== null || !props.online) return;
    props.onClearError?.();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = data.get("currentPassword");
    const newPassword = data.get("newPassword");
    const confirmation = data.get("newPasswordConfirmation");
    const username = data.get("username");
    const currentPasswordValue = typeof currentPassword === "string" ? currentPassword : "";
    const newPasswordValue = typeof newPassword === "string" ? newPassword : "";
    const confirmationValue = typeof confirmation === "string" ? confirmation : "";
    const usernameValue = typeof username === "string" ? username : "";
    const errors: typeof validationErrors = {};
    if (currentPasswordValue.length === 0) {
      errors.currentPassword = "Enter your current password.";
    } else if (currentPasswordValue.length > 128) {
      errors.currentPassword = "Use no more than 128 characters.";
    }
    if (usernameValue.length === 0) {
      errors.username = "Enter the Operator username.";
    } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(usernameValue)) {
      errors.username =
        "Start with a letter or number, then use only letters, numbers, dots, underscores, or hyphens.";
    } else if (usernameValue.length > 64) {
      errors.username = "Use no more than 64 characters.";
    }
    if (newPasswordValue.length < 12) {
      errors.newPassword = "Use at least 12 characters.";
    } else if (newPasswordValue.length > 128) {
      errors.newPassword = "Use no more than 128 characters.";
    }
    if (confirmationValue.length === 0) {
      errors.newPasswordConfirmation = "Confirm the new password.";
    } else if (newPasswordValue !== confirmationValue) {
      errors.newPasswordConfirmation = "The new password confirmation does not match.";
    }
    if (Object.keys(errors).length > 0) {
      const focusField = credentialFieldOrder.find((name) => errors[name] !== undefined);
      setValidationErrors(errors);
      if (focusField !== undefined) {
        setValidationFocusRequest({ field: focusField, message: errors[focusField] ?? "" });
      }
      clearPasswordFields(form);
      return;
    }

    setValidationErrors({});
    setValidationFocusRequest(null);
    credentialSubmission.current = true;
    try {
      await props.onChangeCredentials({
        currentPassword: currentPasswordValue,
        newPassword: newPasswordValue,
        username: usernameValue,
      });
    } finally {
      credentialSubmission.current = false;
      clearPasswordFields(form);
    }
  };

  const controlsDisabled = !props.online || props.pending !== null;
  return (
    <section className="operator-security" aria-labelledby="operator-security-title">
      <div className="section-heading">
        <div>
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
        </div>

        <form
          className="security-form"
          aria-busy={props.pending === "credentials"}
          noValidate
          onSubmit={(event) => void handleSubmit(event)}
          ref={formRef}
        >
          <div>
            <h3>Change credentials</h3>
            <p className="required-note">All fields are required.</p>
          </div>
          <div className="form-field">
            <Label htmlFor="operator-current-password">Current password</Label>
            <Input
              aria-describedby={
                validationErrors.currentPassword === undefined
                  ? undefined
                  : "operator-current-password-error"
              }
              aria-invalid={validationErrors.currentPassword !== undefined}
              autoComplete="current-password"
              disabled={props.pending !== null}
              id="operator-current-password"
              maxLength={128}
              name="currentPassword"
              onInput={() => clearValidationError("currentPassword")}
              required
              type="password"
            />
            {validationErrors.currentPassword === undefined ? null : (
              <FormFieldError id="operator-current-password-error">
                {validationErrors.currentPassword}
              </FormFieldError>
            )}
          </div>
          <div className="form-field">
            <Label htmlFor="operator-username">Operator username</Label>
            <Input
              aria-describedby={
                validationErrors.username === undefined ? undefined : "operator-username-error"
              }
              aria-invalid={validationErrors.username !== undefined}
              autoComplete="username"
              defaultValue={props.session.operator.username}
              disabled={props.pending !== null}
              id="operator-username"
              maxLength={64}
              name="username"
              onInput={() => clearValidationError("username")}
              pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
              required
              type="text"
            />
            {validationErrors.username === undefined ? null : (
              <FormFieldError id="operator-username-error">
                {validationErrors.username}
              </FormFieldError>
            )}
          </div>
          <div className="form-field">
            <Label htmlFor="operator-new-password">New password</Label>
            <Input
              aria-describedby={
                validationErrors.newPassword === undefined
                  ? undefined
                  : "operator-new-password-error"
              }
              aria-invalid={validationErrors.newPassword !== undefined}
              autoComplete="new-password"
              disabled={props.pending !== null}
              id="operator-new-password"
              maxLength={128}
              minLength={12}
              name="newPassword"
              onInput={() => clearValidationError("newPassword")}
              required
              type="password"
            />
            {validationErrors.newPassword === undefined ? null : (
              <FormFieldError id="operator-new-password-error">
                {validationErrors.newPassword}
              </FormFieldError>
            )}
          </div>
          <div className="form-field">
            <Label htmlFor="operator-new-password-confirmation">Confirm new password</Label>
            <Input
              aria-describedby={
                validationErrors.newPasswordConfirmation === undefined
                  ? undefined
                  : "operator-new-password-confirmation-error"
              }
              aria-invalid={validationErrors.newPasswordConfirmation !== undefined}
              autoComplete="new-password"
              disabled={props.pending !== null}
              id="operator-new-password-confirmation"
              maxLength={128}
              minLength={12}
              name="newPasswordConfirmation"
              onInput={() => clearValidationError("newPasswordConfirmation")}
              required
              type="password"
            />
            {validationErrors.newPasswordConfirmation === undefined ? null : (
              <FormFieldError id="operator-new-password-confirmation-error">
                {validationErrors.newPasswordConfirmation}
              </FormFieldError>
            )}
          </div>
          {validationFocusRequest === null ? null : (
            <FormFeedback kind="error" visuallyHidden>
              {validationFocusRequest.message}
            </FormFeedback>
          )}
          {props.pending !== "credentials" &&
          firstInvalidField === undefined &&
          credentialError !== null ? (
            <FormFeedback focus kind="error" title="Credential change failed">
              {credentialError}
            </FormFeedback>
          ) : null}
          <Button type="submit" disabled={controlsDisabled}>
            {props.pending === "credentials"
              ? "Changing credentials…"
              : "Change credentials and sign out"}
          </Button>
          <p className="form-help">
            Verifies the current password, then invalidates every signed-in device.
          </p>
        </form>
        {props.pending === "credentials" ? (
          <FormFeedback kind="pending" visuallyHidden>
            Changing credentials…
          </FormFeedback>
        ) : null}
      </div>
    </section>
  );
}
