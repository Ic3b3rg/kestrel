// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@kestrel/contracts";

import {
  OperatorSecurityPanel,
  type OperatorCredentialFormValue,
  type OperatorSecurityError,
} from "./OperatorSecurityPanel.js";

const session: Session = {
  schemaVersion: 1,
  operator: {
    id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
    username: "operator",
  },
  credentialVersion: "1",
  issuedAt: "2026-09-21T08:00:00.000Z",
  expiresAt: "2026-09-28T08:00:00.000Z",
};

describe("Operator security form feedback", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  function field(name: string): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (input === null) throw new Error(`Missing ${name} field`);
    return input;
  }

  function submitCredentials(): void {
    const form = container.querySelector("form");
    if (form === null) throw new Error("Missing credential form");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  it("keeps the username, clears secrets, and focuses one associated confirmation error", async () => {
    const onChangeCredentials = vi.fn();
    await act(async () => {
      root.render(
        createElement(OperatorSecurityPanel, {
          error: null,
          online: true,
          onChangeCredentials,
          onLogout: vi.fn(),
          pending: null,
          session,
        }),
      );
    });
    const currentPassword = field("currentPassword");
    const username = field("username");
    const newPassword = field("newPassword");
    const confirmation = field("newPasswordConfirmation");
    currentPassword.value = "current correct horse battery staple";
    username.value = "operator-renamed";
    newPassword.value = "a newly selected correct horse battery staple";
    confirmation.value = "a different new password";

    await act(async () => submitCredentials());

    expect(onChangeCredentials).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(confirmation);
    expect(username.value).toBe("operator-renamed");
    expect(currentPassword.value).toBe("");
    expect(newPassword.value).toBe("");
    expect(confirmation.value).toBe("");
    expect(confirmation.getAttribute("aria-invalid")).toBe("true");
    const errorId = confirmation.getAttribute("aria-describedby");
    expect(errorId).not.toBeNull();
    expect(document.getElementById(errorId ?? "")?.textContent).toContain("does not match");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  it("renders a sign-out failure beside the command that caused it", async () => {
    await act(async () => {
      root.render(
        createElement(OperatorSecurityPanel, {
          error: {
            action: "logout",
            message: "Kestrel could not sign out this browser.",
          },
          online: true,
          onChangeCredentials: vi.fn(),
          onLogout: vi.fn(),
          pending: null,
          session,
        }),
      );
    });

    const sessionSurface = container.querySelector(".security-session");
    const credentialsSurface = container.querySelector(".security-form");
    const alert = sessionSurface?.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("Kestrel could not sign out this browser.");
    expect(document.activeElement).toBe(alert);
    expect(credentialsSurface?.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  it("announces one pending credential command, blocks duplicates, and restores the form", async () => {
    const submission = Promise.withResolvers<void>();
    const onChangeCredentials = vi.fn(async (_value: OperatorCredentialFormValue) => {
      await submission.promise;
    });

    function Harness() {
      const [pending, setPending] = useState<"credentials" | "logout" | null>(null);
      const [error, setError] = useState<OperatorSecurityError | null>(null);
      return createElement(OperatorSecurityPanel, {
        error,
        online: true,
        onChangeCredentials: async (value) => {
          setPending("credentials");
          setError(null);
          await onChangeCredentials(value);
          setError({ action: "credentials", message: "The request was rejected." });
          setPending(null);
        },
        onLogout: vi.fn(),
        pending,
        session,
      });
    }

    await act(async () => root.render(createElement(Harness)));
    const currentPassword = field("currentPassword");
    const username = field("username");
    const newPassword = field("newPassword");
    const confirmation = field("newPasswordConfirmation");
    currentPassword.value = "current correct horse battery staple";
    username.value = "operator-renamed";
    newPassword.value = "a newly selected correct horse battery staple";
    confirmation.value = "a newly selected correct horse battery staple";

    await act(async () => {
      submitCredentials();
      submitCredentials();
      await Promise.resolve();
    });

    expect(onChangeCredentials).toHaveBeenCalledOnce();
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit?.disabled).toBe(true);
    expect(submit?.textContent).toContain("Changing credentials");
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Changing credentials",
    );

    await act(async () => {
      submission.resolve();
      await submission.promise;
      await Promise.resolve();
    });

    const alert = container.querySelector<HTMLElement>('.security-form [role="alert"]');
    expect(alert?.textContent).toContain("The request was rejected.");
    expect(document.activeElement).toBe(alert);
    expect(username.value).toBe("operator-renamed");
    expect(currentPassword.value).toBe("");
    expect(newPassword.value).toBe("");
    expect(confirmation.value).toBe("");
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
    expect(submit?.disabled).toBe(false);
  });

  it("announces one pending sign-out command, blocks duplicates, and restores its action", async () => {
    const submission = Promise.withResolvers<void>();
    const onLogout = vi.fn(async () => {
      await submission.promise;
    });

    function Harness() {
      const [pending, setPending] = useState<"credentials" | "logout" | null>(null);
      const [error, setError] = useState<OperatorSecurityError | null>(null);
      return createElement(OperatorSecurityPanel, {
        error,
        online: true,
        onChangeCredentials: vi.fn(),
        onLogout: async () => {
          setPending("logout");
          setError(null);
          await onLogout();
          setError({ action: "logout", message: "Kestrel could not sign out this browser." });
          setPending(null);
        },
        pending,
        session,
      });
    }

    await act(async () => root.render(createElement(Harness)));
    const signOut = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Sign out",
    );
    if (signOut === undefined) throw new Error("Missing sign-out button");

    await act(async () => {
      signOut.click();
      signOut.click();
      await Promise.resolve();
    });

    expect(onLogout).toHaveBeenCalledOnce();
    expect(signOut.disabled).toBe(true);
    expect(signOut.textContent).toContain("Signing out");
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);

    await act(async () => {
      submission.resolve();
      await submission.promise;
      await Promise.resolve();
    });

    const alert = container.querySelector<HTMLElement>('.security-session [role="alert"]');
    expect(alert?.textContent).toContain("Kestrel could not sign out this browser.");
    expect(document.activeElement).toBe(alert);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
    expect(signOut.disabled).toBe(false);
  });

  it("keeps both security commands unavailable while offline", async () => {
    await act(async () => {
      root.render(
        createElement(OperatorSecurityPanel, {
          error: null,
          online: false,
          onChangeCredentials: vi.fn(),
          onLogout: vi.fn(),
          pending: null,
          session,
        }),
      );
    });

    expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  });
});
