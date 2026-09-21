import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Label } from "./components/ui/label.js";
import { FormFeedback, FormFieldError } from "./components/FormFeedback.js";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";

import type { LoginCommand } from "@kestrel/contracts";

interface LoginViewProps {
  checking: boolean;
  error: string | null;
  online: boolean;
  pending: boolean;
  success?: string | null;
  onClearFeedback?(): void;
  onSubmit(command: LoginCommand): Promise<void>;
}

export function LoginView(props: LoginViewProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const submitting = useRef(false);
  const [validationErrors, setValidationErrors] = useState<{
    password?: string;
    username?: string;
  }>({});
  const firstInvalidField = (["username", "password"] as const).find(
    (name) => validationErrors[name] !== undefined,
  );

  useEffect(() => {
    if (firstInvalidField === undefined) return;
    const input = formRef.current?.elements.namedItem(firstInvalidField);
    if (input instanceof HTMLInputElement) input.focus();
  }, [firstInvalidField, validationErrors]);

  const clearValidationError = (name: "password" | "username") => {
    setValidationErrors((current) => {
      if (current[name] === undefined) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  const handleSubmit = async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    if (submitting.current || props.pending || !props.online) return;
    props.onClearFeedback?.();
    const form = event.currentTarget;
    const data = new FormData(form);
    const username = data.get("username");
    const password = data.get("password");
    const passwordInput = form.elements.namedItem("password");
    const usernameValue = typeof username === "string" ? username : "";
    const passwordValue = typeof password === "string" ? password : "";
    const errors: { password?: string; username?: string } = {};
    if (usernameValue.length === 0) {
      errors.username = "Enter your Operator username.";
    } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(usernameValue)) {
      errors.username =
        "Start with a letter or number, then use only letters, numbers, dots, underscores, or hyphens.";
    } else if (usernameValue.length > 64) {
      errors.username = "Use no more than 64 characters.";
    }
    if (passwordValue.length === 0) {
      errors.password = "Enter your password.";
    } else if (passwordValue.length > 128) {
      errors.password = "Use no more than 128 characters.";
    }
    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      if (passwordInput instanceof HTMLInputElement) passwordInput.value = "";
      return;
    }

    setValidationErrors({});
    submitting.current = true;
    try {
      await props.onSubmit({
        username: usernameValue,
        password: passwordValue,
      });
    } finally {
      submitting.current = false;
      if (passwordInput instanceof HTMLInputElement) {
        passwordInput.value = "";
      }
    }
  };

  return (
    <>
      <a className="skip-link" href="#login-main">
        Skip to sign in
      </a>
      <header className="site-header">
        <p className="wordmark">
          <span aria-hidden="true">K</span> KESTREL
        </p>
        <p className="auth-boundary">Local Operator access</p>
      </header>

      <main id="login-main" className="login-main" tabIndex={-1}>
        {props.checking ? (
          <section className="system-state" aria-busy="true" aria-label="Checking Operator session">
            <h1>Checking Operator session</h1>
            <p>Kestrel is verifying the host-scoped session with the local Installation.</p>
            <div className="loading-lines" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          </section>
        ) : (
          <section className="login-layout" aria-labelledby="login-title">
            <div className="login-intro">
              <h1 id="login-title">Sign in to Kestrel</h1>
              <p className="lede">
                Your Projects, plans, and reviews in one place. Sign in with your local Operator
                account.
              </p>
            </div>

            <form
              aria-busy={props.pending}
              className="login-form"
              noValidate
              onSubmit={(event) => void handleSubmit(event)}
              ref={formRef}
            >
              <div className="form-field">
                <Label htmlFor="username">Username</Label>
                <Input
                  aria-describedby={
                    validationErrors.username === undefined ? undefined : "username-error"
                  }
                  aria-invalid={validationErrors.username !== undefined}
                  autoComplete="username"
                  disabled={props.pending}
                  id="username"
                  maxLength={64}
                  name="username"
                  onInput={() => clearValidationError("username")}
                  pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
                  required
                  type="text"
                />
                {validationErrors.username === undefined ? null : (
                  <FormFieldError id="username-error">{validationErrors.username}</FormFieldError>
                )}
              </div>
              <div className="form-field">
                <Label htmlFor="password">Password</Label>
                <Input
                  aria-describedby={
                    validationErrors.password === undefined ? undefined : "password-error"
                  }
                  aria-invalid={validationErrors.password !== undefined}
                  autoComplete="current-password"
                  disabled={props.pending}
                  id="password"
                  maxLength={128}
                  name="password"
                  onInput={() => clearValidationError("password")}
                  required
                  type="password"
                />
                {validationErrors.password === undefined ? null : (
                  <FormFieldError id="password-error">{validationErrors.password}</FormFieldError>
                )}
              </div>
              {firstInvalidField === undefined ? null : (
                <FormFeedback kind="error" visuallyHidden>
                  {validationErrors[firstInvalidField]}
                </FormFeedback>
              )}
              {props.pending ? (
                <FormFeedback kind="pending" visuallyHidden>
                  Signing in…
                </FormFeedback>
              ) : firstInvalidField !== undefined ? null : props.error ? (
                <FormFeedback focus kind="error" title="Sign-in failed">
                  {props.error}
                </FormFeedback>
              ) : props.success ? (
                <FormFeedback kind="success">{props.success}</FormFeedback>
              ) : null}
              <Button type="submit" disabled={!props.online || props.pending}>
                {props.pending ? "Signing in…" : "Sign in"}
              </Button>
              <p className="form-help">
                {props.online
                  ? "Use the account created when you set up Kestrel."
                  : "Reconnect before signing in."}
              </p>
            </form>
          </section>
        )}
      </main>

      <footer>
        <span>Kestrel</span>
        <span>One local Operator</span>
      </footer>
    </>
  );
}
