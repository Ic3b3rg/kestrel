// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { FeatureNavigation } from "./FeatureNavigation.js";
import { SidebarProvider } from "./components/ui/sidebar.js";
import type { AppRoute } from "./app-route.js";
import type * as apiModule from "./api.js";

const requests = vi.hoisted(() => ({ features: vi.fn(), create: vi.fn() }));
vi.mock("./api.js", async (original) => ({
  ...(await original<typeof apiModule>()),
  fetchFeatures: requests.features,
  createFeature: requests.create,
}));

it("opens a blank planning URL directly and creates no Feature before a prompt", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  requests.features.mockResolvedValue({ schemaVersion: 1, features: [] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const navigate = vi.fn<(route: AppRoute) => void>();
  try {
    await act(async () => {
      await Promise.resolve(
        root.render(
          createElement(SidebarProvider, {
            children: createElement(FeatureNavigation, {
              projectId: "01991c36-7f90-7000-8000-000000000001",
              online: true,
              onNavigate: navigate,
              onAuthenticationError: () => false,
            }),
          }),
        ),
      );
    });
    const start = [...container.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === "Start plan",
    );
    expect(start).toBeDefined();
    await act(async () => {
      await Promise.resolve(start?.click());
    });
    expect(navigate.mock.calls[0]?.[0]).toMatchObject({
      kind: "planning",
      projectId: "01991c36-7f90-7000-8000-000000000001",
    });
    const route = navigate.mock.calls[0]?.[0];
    if (route?.kind !== "planning") throw new Error("Missing planning route");
    expect(route.requestId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(requests.create).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
