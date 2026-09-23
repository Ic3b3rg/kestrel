// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { defaultLifecycleSettings } from "@kestrel/contracts";
import { LifecycleProfilePanel } from "./LifecycleProfilePanel.js";
import { lifecycleProfileFixture } from "./lifecycle-profile.test-support.js";

it("replaces a no-longer-installed Skill version with the installed upgrade", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const oldDigest = "a".repeat(64),
    newDigest = "b".repeat(64);
  const writes: unknown[] = [];
  vi.spyOn(document, "cookie", "get").mockReturnValue(
    "__Host-kestrel-csrf=" + "a".repeat(43) + "." + "b".repeat(43),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, options?: RequestInit) => {
      if (options?.method === "PUT" && typeof options.body === "string")
        writes.push(JSON.parse(options.body));
      return Promise.resolve(
        Response.json(
          url.includes("lifecycle-profiles")
            ? {
                ...lifecycleProfileFixture(),
                overrides: { skillDigests: [oldDigest] },
                resolved: null,
                blocked: "Choose an installed Skill version.",
              }
            : {
                schemaVersion: 1,
                skills: [
                  {
                    name: "review-guide",
                    description: "Current review guide",
                    contentDigest: newDigest,
                    source: { kind: "host", label: "Fixture", candidateId: newDigest },
                  },
                ],
              },
        ),
      );
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        createElement(LifecycleProfilePanel, {
          projectId: "01991c36-7f90-7000-8000-000000000002",
          online: true,
        }),
      );
      await Promise.resolve();
    });
    const stale = [...container.querySelectorAll("label")]
      .find((label) => label.textContent.includes("no longer installed"))
      ?.querySelector("input");
    const current = [...container.querySelectorAll("label")]
      .find((label) => label.textContent.includes("review-guide"))
      ?.querySelector("input");
    if (stale === null || stale === undefined || current === null || current === undefined)
      throw new Error("Missing Skill choices");
    await act(async () => {
      stale.click();
      await Promise.resolve();
    });
    await act(async () => {
      current.click();
      await Promise.resolve();
    });
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save profile",
    );
    if (save === undefined) throw new Error("Missing Save profile");
    await act(async () => {
      save.click();
      await Promise.resolve();
    });
    expect(writes).toEqual([{ expectedVersion: 0, settings: { skillDigests: [newDigest] } }]);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

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
