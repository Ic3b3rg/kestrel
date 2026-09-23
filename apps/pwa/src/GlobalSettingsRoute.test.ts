// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session } from "@kestrel/contracts";
import { GlobalSettingsRoute, type GlobalSettingsRouteProps } from "./GlobalSettingsView.js";
import type * as apiModule from "./api.js";
const updateCredentials = vi.hoisted(() => vi.fn<typeof apiModule.updateOperatorCredentials>());
vi.mock("./api.js", async (original) => ({
  ...(await original<typeof apiModule>()),
  updateOperatorCredentials: updateCredentials,
}));
const session: Session = {
  schemaVersion: 1,
  operator: { id: "01991c36-7f90-7000-8000-000000000001", username: "operator" },
  credentialVersion: "1",
  issuedAt: "2026-09-23T12:00:00.000Z",
  expiresAt: "2026-09-30T12:00:00.000Z",
};
let root: Root;
let container: HTMLDivElement;
const pending = vi.fn<(pending: boolean) => void>();
const changed = vi.fn<(message: string) => void>();
const authentication = vi.fn(() => false);
async function render(props: Partial<GlobalSettingsRouteProps> = {}) {
  await act(async () => {
    root.render(
      createElement(GlobalSettingsRoute, {
        section: "profile",
        sessionCommandBlocked: false,
        online: true,
        session,
        projects: [],
        projectsError: null,
        projectsLoading: false,
        onRetryProjects: vi.fn(),
        onNavigate: vi.fn(),
        onOpenProjectSettings: vi.fn(),
        onAuthenticationError: authentication,
        onCredentialsChanged: changed,
        onSessionCommandPending: pending,
        ...props,
      }),
    );
    await Promise.resolve();
  });
}
async function submit() {
  for (const [name, value] of Object.entries({
    currentPassword: "current fixture passphrase",
    username: "updated-operator",
    newPassword: "new secure fixture passphrase",
    newPasswordConfirmation: "new secure fixture passphrase",
  })) {
    const field = container.querySelector<HTMLInputElement>(`[name="${name}"]`);
    if (field === null) throw new Error(`Missing field ${name}`);
    field.value = value;
  }
  await act(async () => {
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  updateCredentials.mockReset().mockResolvedValue(undefined);
  pending.mockReset();
  changed.mockReset();
  authentication.mockReset().mockReturnValue(false);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("changes credentials from global Profile without selecting a Project", async () => {
  await render();
  await submit();
  expect(updateCredentials).toHaveBeenCalledOnce();
  expect(updateCredentials.mock.calls[0]?.[0]).toMatchObject({
    session,
    username: "updated-operator",
  });
  expect(pending).toHaveBeenCalledWith(true);
  expect(pending).toHaveBeenLastCalledWith(false);
  expect(changed).toHaveBeenCalledWith(
    "Credentials changed. Sign in with your updated Operator account.",
  );
});
it("owns command errors within Profile and preserves the session boundary", async () => {
  const failure = new Error("unavailable");
  updateCredentials.mockRejectedValueOnce(failure);
  await render();
  await submit();
  expect(container.textContent).toContain("Kestrel could not change the Operator credentials.");
  expect(changed).not.toHaveBeenCalled();
  expect(authentication).toHaveBeenCalledWith(failure);
});
it.each(["offline", "navigation"] as const)(
  "cancels a credential change on %s and ignores late success",
  async (reason) => {
    const deferred = Promise.withResolvers<undefined>();
    updateCredentials.mockReturnValueOnce(deferred.promise);
    await render();
    await submit();
    const signal = updateCredentials.mock.calls[0]?.[1];
    if (reason === "offline") await render({ online: false });
    else
      await act(async () => {
        root.render(null);
        await Promise.resolve();
      });
    expect(signal?.aborted).toBe(true);
    expect(pending).toHaveBeenLastCalledWith(false);
    await act(async () => {
      deferred.resolve(undefined);
      await deferred.promise;
    });
    expect(changed).not.toHaveBeenCalled();
  },
);

it("does not start a credential command while sign-out owns the session action", async () => {
  await render({ sessionCommandBlocked: true });
  await submit();
  expect(updateCredentials).not.toHaveBeenCalled();
});
