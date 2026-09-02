// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalRepositoryInventory, ProjectUpserted } from "@kestrel/contracts";

import { OpenProjectForm, type OpenProjectFormProps } from "./OpenProjectForm.js";

const repositoryId = "018f0f89-9a1d-7484-b224-866ef9d69990";
const opened: ProjectUpserted = {
  schemaVersion: 1,
  project: {
    changeProposals: [],
    createdAt: "2026-08-24T12:00:00.000Z",
    id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
    localRepositorySource: {
      createdAt: "2026-08-24T12:00:00.000Z",
      displayName: "kestrel",
      id: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
      objectFormat: "sha1",
      repositoryId,
      state: "attached",
      updatedAt: "2026-08-24T12:00:00.000Z",
    },
    modelAccess: "not_configured",
    providerObservation: null,
    repository: null,
    sourceAvailability: "not_acquired",
    updatedAt: "2026-08-24T12:00:00.000Z",
  },
};

const readyInventory: LocalRepositoryInventory = {
  schemaVersion: 1,
  inventoryState: "ready",
  repositories: [{ attachmentState: "unattached", displayName: "kestrel", repositoryId }],
};

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent.includes(label),
  );
  if (button === undefined) throw new Error(`Button not found: ${label}`);
  return button;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

async function selectRepository(container: HTMLElement): Promise<void> {
  const select = container.querySelector("select");
  if (!(select instanceof HTMLSelectElement)) throw new Error("Repository select not found");
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called below with the select as its receiver.
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("Native select setter unavailable");
  await act(async () => {
    setter.call(select, repositoryId);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("Open Project form", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: Partial<OpenProjectFormProps> = {}) {
    const defaults: OpenProjectFormProps = {
      disabled: false,
      loadRepositories: vi.fn().mockResolvedValue(readyInventory),
      onOpened: vi.fn(),
      openProject: vi.fn().mockResolvedValue(opened),
    };
    act(() => root.render(createElement(OpenProjectForm, { ...defaults, ...props })));
    return defaults;
  }

  it("opens a durable Project using only the selected opaque repository ID", async () => {
    const openProject = vi.fn().mockResolvedValue(opened);
    const onOpened = vi.fn();
    render({ onOpened, openProject });

    await click(findButton(container, "Open Project"));
    await selectRepository(container);
    await click(findButton(container, "Open selected Project"));

    expect(openProject).toHaveBeenCalledWith({ repositoryId }, expect.any(AbortSignal));
    expect(JSON.stringify(openProject.mock.calls[0])).not.toContain("/Users/");
    expect(onOpened).toHaveBeenCalledWith(opened);
    expect(container.querySelector("dialog")).toBeNull();
  });

  it("shows the honest empty trusted-host state", async () => {
    render({
      loadRepositories: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        inventoryState: "no_configured_roots",
        repositories: [],
      }),
    });

    await click(findButton(container, "Open Project"));

    expect(container.textContent).toContain("No repository roots are configured");
    expect(container.textContent).toContain("authorize-repository-root");
  });

  it("keeps repository discovery failures inside the dialog", async () => {
    render({ loadRepositories: vi.fn().mockRejectedValue(new Error("private path detail")) });

    await click(findButton(container, "Open Project"));

    expect(container.textContent).toContain("Repository discovery failed");
    expect(container.textContent).toContain("Kestrel could not list authorized repositories");
    expect(container.textContent).not.toContain("private path detail");
  });
});
