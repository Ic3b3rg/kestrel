// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ProjectInboxPanel } from "./ProjectInboxPanel.js";

it("rejects a public URL from another repository before observing it", async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onOpen = vi.fn();
  try {
    await act(async () =>
      root.render(
        createElement(ProjectInboxPanel, {
          error: null,
          loading: false,
          online: true,
          pending: false,
          onOpen,
          onRetry: vi.fn(),
          inbox: {
            schemaVersion: 1,
            projects: [
              {
                id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
                changeProposals: [],
                createdAt: "2026-09-02T12:00:00.000Z",
                updatedAt: "2026-09-02T12:00:00.000Z",
                localRepositorySource: null,
                modelAccess: "not_configured",
                sourceAvailability: "not_acquired",
                providerObservation: {
                  kind: "public_github",
                  authentication: "none",
                  refresh: "manual",
                },
                repository: {
                  owner: "owner",
                  name: "selected",
                  canonicalUrl: "https://github.com/owner/selected",
                  providerId: "R_selected",
                },
              },
            ],
          },
        }),
      ),
    );
    const input = container.querySelector('input[type="url"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("Public URL entry missing");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, "https://github.com/owner/unrelated/pull/1");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      input
        .closest("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(onOpen).not.toHaveBeenCalled();
    expect(container.textContent).toContain("This URL belongs to a different repository");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
