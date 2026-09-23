// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { defaultLifecycleSettings } from "@kestrel/contracts";
import { LifecycleProfilePanel } from "./LifecycleProfilePanel.js";

it("retains a Project override after a failed save and retries against the observed version", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const writes: unknown[] = [];
  vi.spyOn(document, "cookie", "get").mockReturnValue(
    "__Host-kestrel-csrf=" + "a".repeat(43) + "." + "b".repeat(43),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, options?: RequestInit) => {
      if (options?.method === "PUT") {
        if (typeof options.body !== "string") throw new Error("Expected a JSON request");
        writes.push(JSON.parse(options.body));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              schemaVersion: 1,
              code: "SERVICE_UNAVAILABLE",
              correlationId: "5650ab65-1b94-462f-9043-ac416c886840",
              message: "Settings are temporarily unavailable.",
            }),
            { status: 503, headers: { "content-type": "application/json" } },
          ),
        );
      }
      const body = url.includes("planning-skills")
        ? { schemaVersion: 1, skills: [] }
        : {
            phase: "planning",
            versions: { installation: 3, project: 2 },
            defaults: defaultLifecycleSettings,
            overrides: {},
            models: [{ id: "example", displayName: "Example", isDefault: true }],
            resolved: null,
            blocked: "Connect the runtime.",
          };
      return Promise.resolve(
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
      );
    }),
  );
  try {
    await act(async () => {
      await Promise.resolve();
      root.render(
        createElement(LifecycleProfilePanel, {
          projectId: "01991c36-7f90-7000-8000-000000000002",
          online: true,
        }),
      );
    });
    const label = [...container.querySelectorAll("label")].find(
      (label) => label.textContent === "Model",
    );
    const select = document.getElementById(label?.htmlFor ?? "");
    if (!(select instanceof HTMLSelectElement)) throw new Error("Model selector unavailable");
    await act(async () => {
      select.value = "value:example";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save profile",
    );
    if (save === undefined) throw new Error("Save profile unavailable");
    await act(async () => {
      save.click();
      await Promise.resolve();
    });
    expect(select.value).toBe("value:example");
    expect(writes).toEqual([
      { expectedVersion: 2, settings: { model: { kind: "explicit", value: "example" } } },
    ]);
    expect(document.activeElement?.textContent).toContain("temporarily unavailable");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
