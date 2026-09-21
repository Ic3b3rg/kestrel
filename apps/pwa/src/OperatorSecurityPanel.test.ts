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

  async function typeAtFocusedField(value: string): Promise<void> {
    for (const character of value) {
      await act(async () => {
        const input = document.activeElement;
        if (!(input instanceof HTMLInputElement)) {
          throw new Error("The focused element is not an input");
        }
        input.value += character;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await Promise.resolve();
      });
    }
  }

  it("keeps the username, clears secrets, and focuses one associated confirmation error", () => {
    const onChangeCredentials = vi.fn();
    act(() => {
      root.render(
        createElement(OperatorSecurityPanel, {
          error: null,
          online: true,
          onChangeCredentials,
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

    act(() => submitCredentials());

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

  it("does not move focus to another invalid field while the Operator corrects the first", async () => {
    act(() => {
      root.render(
        createElement(OperatorSecurityPanel, {
          error: null,
          online: true,
          onChangeCredentials: vi.fn(),
          pending: null,
          session,
        }),
      );
    });

    act(() => submitCredentials());

    const currentPassword = field("currentPassword");
    const newPassword = field("newPassword");
    expect(document.activeElement).toBe(currentPassword);

    await typeAtFocusedField("current password");

    expect(document.activeElement).toBe(currentPassword);
    expect(currentPassword.value).toBe("current password");
    expect(newPassword.value).toBe("");
  });

  it("does not expose a duplicate Sign out action in Settings", () => {
    act(() => {
      root.render(
        createElement(OperatorSecurityPanel, {
          error: {
            action: "logout",
            message: "Kestrel could not sign out this browser.",
          },
          online: true,
          onChangeCredentials: vi.fn(),
          pending: null,
          session,
        }),
      );
    });

    expect(
      [...container.querySelectorAll("button")].map((button) => button.textContent),
    ).not.toContain("Sign out");
    expect(container.textContent).not.toContain("Clears only this browser");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("announces one pending credential command, blocks duplicates, and restores the form", async () => {
    const submission = Promise.withResolvers<undefined>();
    const onChangeCredentials = vi.fn((value: OperatorCredentialFormValue) => {
      void value.username;
      return submission.promise;
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
        pending,
        session,
      });
    }

    act(() => root.render(createElement(Harness)));
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
    expect(container.querySelector('[role="status"]')?.closest('[aria-busy="true"]')).toBeNull();

    await act(async () => {
      submission.resolve(undefined);
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

  it("keeps the credential command unavailable while offline", () => {
    act(() => {
      root.render(
        createElement(OperatorSecurityPanel, {
          error: null,
          online: false,
          onChangeCredentials: vi.fn(),
          pending: null,
          session,
        }),
      );
    });

    expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  });
});
