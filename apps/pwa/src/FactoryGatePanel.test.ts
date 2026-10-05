// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { FactoryGate } from "@kestrel/contracts";
import type * as apiModule from "./factory-execution-api.js";
import { FactoryGatePanel } from "./FactoryGatePanel.js";

const api = vi.hoisted(() => ({ resolve: vi.fn<typeof apiModule.resolveFactoryGate>() }));
vi.mock("./factory-execution-api.js", () => ({ resolveFactoryGate: api.resolve }));

it("requests server inspection of a restored workspace without a product answer form", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const id = "01991c36-7f90-7000-8000-000000000001";
  const gate: FactoryGate = {
    schemaVersion: 1,
    id,
    featureId: id,
    runId: id,
    workItemId: id,
    approvedVersion: 1,
    reason: "source_changed",
    question: "Saved source differs",
    requiredDecision: "inspect_workspace",
    createdAt: "2026-10-05T13:00:00.000Z",
    resolution: null,
    successorRunId: null,
    canResume: false,
    resumeBlockedReason: "workspace_uncertain",
  };
  api.resolve.mockReset().mockImplementation((_project, _feature, _gate, command) =>
    Promise.resolve({
      ...gate,
      resumeBlockedReason: "already_resolved",
      resolution: { ...command, operatorId: id, resolvedAt: gate.createdAt },
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onResolved = vi.fn();
  try {
    await act(async () => {
      root.render(
        createElement(FactoryGatePanel, {
          projectId: id,
          gate,
          active: true,
          onResolved,
          onAuthenticationError: () => false,
        }),
      );
      await Promise.resolve();
    });
    expect(container.querySelector("textarea")).toBeNull();
    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.textContent).toBe("Check workspace and retry");
    expect(button?.disabled).toBe(false);
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(api.resolve).toHaveBeenCalledOnce();
    expect(api.resolve.mock.calls[0]?.[3].decision).toBe("resume_within_plan");
    expect(onResolved).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Retry queued");
    expect(container.querySelector("textarea")).toBeNull();
  } finally {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
    vi.unstubAllGlobals();
  }
});
