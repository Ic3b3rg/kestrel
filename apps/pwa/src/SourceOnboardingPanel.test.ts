// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SourceOnboardingPanel, type authorizeLocalFolder } from "./SourceOnboardingPanel.js";

it("requires explicit confirmation, preserves a failed preview, and refreshes the inventory on success", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const authorize = vi
    .fn<typeof authorizeLocalFolder>()
    .mockResolvedValueOnce({
      state: "preview",
      previewId: "018f0f89-9a1d-7484-b224-866ef9d69990",
      repositories: [
        { repositoryId: "018f0f89-9a1d-7484-b224-866ef9d69991", displayName: "Reports" },
      ],
      skipped: 1,
    })
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ state: "authorized" });
  const onAuthorized = vi.fn();
  const click = async (name: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === name,
    );
    if (button === undefined) throw new Error(`Missing button: ${name}`);
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
  };
  try {
    act(() =>
      root.render(
        createElement(SourceOnboardingPanel, { disabled: false, onAuthorized, authorize }),
      ),
    );
    await click("Local folder");
    expect(container.textContent).toContain("Reports");
    expect(container.textContent).toContain("1 unreadable");
    expect(onAuthorized).not.toHaveBeenCalled();
    await click("Authorize repositories");
    expect(container.querySelector('[role="alert"]')).toBe(document.activeElement);
    expect(container.textContent).toContain("Reports");
    await click("Authorize repositories");
    expect(authorize.mock.calls[1]?.slice(0, 2)).toEqual(authorize.mock.calls[2]?.slice(0, 2));
    expect(onAuthorized).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Repositories authorized");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
