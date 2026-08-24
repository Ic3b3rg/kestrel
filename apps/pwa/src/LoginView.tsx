import { useEffect, useRef, type SyntheticEvent } from "react";

import type { LoginCommand } from "@kestrel/contracts";

interface LoginViewProps {
  checking: boolean;
  error: string | null;
  online: boolean;
  pending: boolean;
  onSubmit(command: LoginCommand): Promise<void>;
}

export function LoginView(props: LoginViewProps) {
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (props.error) {
      errorRef.current?.focus();
    }
  }, [props.error]);

  const handleSubmit = async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const username = data.get("username");
    const password = data.get("password");
    const passwordInput = form.elements.namedItem("password");
    try {
      await props.onSubmit({
        username: typeof username === "string" ? username : "",
        password: typeof password === "string" ? password : "",
      });
    } finally {
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
            <p className="section-index">AUTHENTICATION / SESSION</p>
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
              <p className="eyebrow">AUTHENTICATION / OPERATOR</p>
              <h1 id="login-title">Sign in to Kestrel</h1>
              <p className="lede">
                Use the local credentials created from the trusted host. Kestrel keeps one Operator
                for this Installation.
              </p>
            </div>

            <form className="login-form" onSubmit={(event) => void handleSubmit(event)}>
              <div className="form-field">
                <label htmlFor="username">Username</label>
                <input
                  autoComplete="username"
                  id="username"
                  maxLength={64}
                  name="username"
                  pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
                  required
                  type="text"
                />
              </div>
              <div className="form-field">
                <label htmlFor="password">Password</label>
                <input
                  autoComplete="current-password"
                  id="password"
                  maxLength={128}
                  name="password"
                  required
                  type="password"
                />
              </div>
              {props.error ? (
                <div className="login-error" ref={errorRef} role="alert" tabIndex={-1}>
                  <strong>Sign-in failed</strong>
                  <span>{props.error}</span>
                </div>
              ) : null}
              <button type="submit" disabled={!props.online || props.pending}>
                {props.pending ? "Signing in…" : "Sign in"}
              </button>
              <p className="form-help">
                {props.online
                  ? "The session expires seven days after sign-in and is never refreshed silently."
                  : "Reconnect before signing in."}
              </p>
            </form>
          </section>
        )}
      </main>

      <footer>
        <span>Kestrel V1</span>
        <span>One local Operator</span>
      </footer>
    </>
  );
}
