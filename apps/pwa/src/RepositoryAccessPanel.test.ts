// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalRepositoryInventory } from "@kestrel/contracts";

import { RepositoryAccessPanel, type RepositoryAccessPanelProps } from "./RepositoryAccessPanel.js";

const repositoryId = "018f0f89-9a1d-7484-b224-866ef9d69990";

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent.includes(text),
  );
  if (button === undefined) throw new Error(`Button not found: ${text}`);
  return button;
}

describe("Repository access Settings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
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
  });

  async function renderPanel(overrides: Partial<RepositoryAccessPanelProps> = {}): Promise<void> {
    await act(async () => {
      root.render(
        createElement(RepositoryAccessPanel, {
          online: true,
          ...overrides,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("refreshes from guided setup to bounded labels and opaque repository identities", async () => {
    const ready: LocalRepositoryInventory = {
      schemaVersion: 1,
      inventoryState: "ready",
      repositories: [{ repositoryId, displayName: "team/kestrel", attachmentState: "unattached" }],
    };
    const loadRepositories = vi
      .fn<NonNullable<RepositoryAccessPanelProps["loadRepositories"]>>()
      .mockResolvedValueOnce({
        schemaVersion: 1,
        inventoryState: "no_configured_roots",
        repositories: [],
      })
      .mockResolvedValueOnce(ready);
    await renderPanel({ loadRepositories });

    expect(container.textContent).toContain("Settings");
    expect(container.textContent).toContain("No repository roots are configured");
    expect(container.querySelector('input[type="text"], input[type="file"]')).toBeNull();

    await act(async () => {
      findButton(container, "Refresh repositories").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadRepositories).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("team/kestrel");
    expect(container.textContent).toContain(repositoryId);
    expect(container.textContent).not.toContain("/private/");
    expect(container.querySelector('input[type="text"], input[type="file"]')).toBeNull();
  });
});
