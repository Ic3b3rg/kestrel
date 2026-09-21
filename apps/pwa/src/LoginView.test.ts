// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginCommand } from "@kestrel/contracts";

import { LoginView } from "./LoginView.js";

describe("Login form feedback", () => {
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

  function submit(): void {
    const form = container.querySelector("form");
    if (form === null) throw new Error("Missing login form");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  it("keeps safe input and focuses the first field with one associated validation message", async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(
        createElement(LoginView, {
          checking: false,
          error: null,
          online: true,
          pending: false,
          onSubmit,
        }),
      );
    });
    const username = field("username");
    const password = field("password");
    username.value = "operator name";
    password.value = "not sent";

    await act(async () => submit());

    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(username);
    expect(username.value).toBe("operator name");
    expect(password.value).toBe("");
    expect(username.getAttribute("aria-invalid")).toBe("true");
    const errorId = username.getAttribute("aria-describedby");
    expect(errorId).not.toBeNull();
    expect(document.getElementById(errorId ?? "")?.textContent).toContain(
      "Start with a letter or number",
    );
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  it("announces pending once, blocks duplicate submits, and focuses a retained local failure", async () => {
    const submission = Promise.withResolvers<void>();
    const onSubmit = vi.fn(async (_command: LoginCommand) => {
      await submission.promise;
    });

    function Harness() {
      const [pending, setPending] = useState(false);
      const [error, setError] = useState<string | null>(null);
      return createElement(LoginView, {
        checking: false,
        error,
        online: true,
        pending,
        onSubmit: async (command) => {
          setPending(true);
          setError(null);
          await onSubmit(command);
          setError("The Operator credentials are invalid. Reference: login-test");
          setPending(false);
        },
      });
    }

    await act(async () => root.render(createElement(Harness)));
    const username = field("username");
    const password = field("password");
    username.value = "operator";
    password.value = "incorrect password";

    await act(async () => {
      submit();
      submit();
      await Promise.resolve();
    });

    expect(onSubmit).toHaveBeenCalledOnce();
    const button = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("Signing in");
    const pendingStatuses = container.querySelectorAll('[role="status"]');
    expect(pendingStatuses).toHaveLength(1);
    expect(pendingStatuses[0]?.textContent).toContain("Signing in");

    await act(async () => {
      submission.resolve();
      await submission.promise;
      await Promise.resolve();
    });

    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("The Operator credentials are invalid");
    expect(document.activeElement).toBe(alert);
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
    expect(username.value).toBe("operator");
    expect(password.value).toBe("");
    expect(button?.disabled).toBe(false);
  });

  it("keeps the action unavailable while offline", async () => {
    await act(async () => {
      root.render(
        createElement(LoginView, {
          checking: false,
          error: null,
          online: false,
          pending: false,
          onSubmit: vi.fn(),
        }),
      );
    });

    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      true,
    );
    expect(container.textContent).toContain("Reconnect before signing in.");
  });
});
