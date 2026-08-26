// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  LocalRepositoryInventory,
  LocalRepositoryReferences,
  ProjectInbox,
  ReviewRevisionAvailable,
} from "@kestrel/contracts";

import { ApiClientError } from "./api.js";
import {
  OpenLocalRepositoryForm,
  buildRetainCommand,
  findMatchingProposalOptions,
  type OpenLocalRepositoryFormProps,
} from "./OpenLocalRepositoryForm.js";

const repositoryId = "018f0f89-9a1d-7484-b224-866ef9d69990";
const references: LocalRepositoryReferences = {
  schemaVersion: 1,
  repositoryId,
  objectFormat: "sha1",
  references: [
    {
      ref: "refs/heads/main",
      displayName: "main",
      kind: "local_branch",
      commitObjectId: "a".repeat(40),
      commitSubjectSuggestion: "Base source",
    },
    {
      ref: "refs/heads/topic",
      displayName: "topic",
      kind: "local_branch",
      commitObjectId: "b".repeat(40),
      commitSubjectSuggestion: "Head source",
    },
  ],
};
const repositories: LocalRepositoryInventory = {
  schemaVersion: 1,
  repositories: [{ repositoryId, displayName: "kestrel", attachmentState: "unattached" }],
};

interface Deferred<T> {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent.includes(text),
  );
  if (button === undefined) throw new Error(`Button not found: ${text}`);
  return button;
}

function findControl(
  container: HTMLElement,
  labelText: string,
): HTMLSelectElement | HTMLTextAreaElement {
  const label = [...container.querySelectorAll("label")].find((candidate) =>
    candidate.textContent.includes(labelText),
  );
  const control = label?.htmlFor === undefined ? null : document.getElementById(label.htmlFor);
  if (!(control instanceof HTMLSelectElement) && !(control instanceof HTMLTextAreaElement)) {
    throw new Error(`Control not found: ${labelText}`);
  }
  return control;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

async function changeValue(
  control: HTMLSelectElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const prototype =
    control instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLTextAreaElement.prototype;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called below with the DOM control as its receiver.
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter === undefined) throw new Error("Native value setter is unavailable");
  await act(async () => {
    setter.call(control, value);
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
    await Promise.resolve();
  });
}

describe("Open local repository command", () => {
  it("accepts only two enumerated refs and explicit Operator-authored intent", () => {
    expect(
      buildRetainCommand(references, {
        repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/topic",
        changeIntent: " Review authorization boundaries ",
      }),
    ).toEqual({
      repositoryId,
      baseRef: "refs/heads/main",
      headRef: "refs/heads/topic",
      changeIntent: "Review authorization boundaries",
    });
    expect(() =>
      buildRetainCommand(references, {
        repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/main",
        changeIntent: "Base source",
      }),
    ).toThrow("different");
    expect(() =>
      buildRetainCommand(references, {
        repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/not-enumerated",
        changeIntent: "Review authorization boundaries",
      }),
    ).toThrow("enumerated");
  });

  it("offers every exact inbox proposal and prioritizes the attached repository", () => {
    const sourceId = "018f0f89-9a1d-7484-b224-866ef9d69990";
    const otherRepositoryId = "018f0f89-9a1e-7d64-a5dd-18cc3e317402";
    const project = (
      id: string,
      sourceRepositoryId: string,
      proposalId: string,
    ): ProjectInbox["projects"][number] => ({
      id,
      providerObservation: null,
      repository: null,
      localRepositorySource: {
        id: sourceId,
        repositoryId: sourceRepositoryId,
        displayName: sourceRepositoryId === repositoryId ? "selected" : "other clone",
        state: "attached",
        objectFormat: "sha1",
        createdAt: "2026-08-24T12:00:00.000Z",
        updatedAt: "2026-08-24T12:01:00.000Z",
      },
      sourceAvailability: "available",
      modelAccess: "not_configured",
      createdAt: "2026-08-24T12:00:00.000Z",
      updatedAt: "2026-08-24T12:01:00.000Z",
      changeProposals: [
        {
          kind: "local",
          id: proposalId,
          title: `Proposal ${proposalId}`,
          base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
          head: { objectId: "b".repeat(40), ref: "refs/heads/topic" },
          changeIntent: {
            id: "018f0f89-9a20-79f9-9990-dda80c9b917d",
            version: 1,
            text: "Review authorization boundaries",
            createdAt: "2026-08-24T12:00:30.000Z",
          },
          reviewRevisions: [],
          createdAt: "2026-08-24T12:00:30.000Z",
          updatedAt: "2026-08-24T12:01:00.000Z",
        },
      ],
    });
    const selectedProposalId = "018f0f89-9192-755f-aa96-f72094c734dd";
    const otherProposalId = "018f0f89-9192-755f-aa96-f72094c734de";
    const providerOnly = {
      ...project("018f0f89-949a-75a8-8f61-6df78a843b1f", otherRepositoryId, otherProposalId),
      localRepositorySource: null,
      providerObservation: {
        authentication: "none" as const,
        kind: "public_github" as const,
        refresh: "manual" as const,
      },
      repository: {
        canonicalUrl: "https://github.com/Ic3b3rg/kestrel",
        name: "kestrel",
        owner: "Ic3b3rg",
        providerId: "R_issue90",
      },
    };
    const projects = [
      project("018f0f89-949a-75a8-8f61-6df78a843b1e", repositoryId, selectedProposalId),
      providerOnly,
    ];

    expect(
      findMatchingProposalOptions(projects, repositoryId, "a".repeat(40), "b".repeat(40)),
    ).toEqual([
      { id: selectedProposalId, label: `Proposal ${selectedProposalId}` },
      {
        id: otherProposalId,
        label: `Proposal ${otherProposalId} · Ic3b3rg/kestrel`,
      },
    ]);
  });
});

describe("Open local repository form", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    });
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

  async function renderForm(overrides: Partial<OpenLocalRepositoryFormProps> = {}): Promise<void> {
    await act(async () => {
      root.render(
        createElement(OpenLocalRepositoryForm, {
          disabled: false,
          projects: [],
          onAvailable: vi.fn(),
          ...overrides,
        }),
      );
      await Promise.resolve();
    });
  }

  async function openReadyForm(
    overrides: Partial<OpenLocalRepositoryFormProps> = {},
  ): Promise<void> {
    const inventory = deferred<LocalRepositoryInventory>();
    const refs = deferred<LocalRepositoryReferences>();
    await renderForm({
      loadRepositories: () => inventory.promise,
      loadReferences: () => refs.promise,
      ...overrides,
    });
    await click(findButton(container, "Open local repository"));
    await act(async () => {
      inventory.resolve(repositories);
      await inventory.promise;
    });
    await changeValue(findControl(container, "Repository"), repositoryId);
    await act(async () => {
      refs.resolve(references);
      await refs.promise;
    });
    await changeValue(findControl(container, "Base reference"), "refs/heads/main");
    await changeValue(findControl(container, "Head reference"), "refs/heads/topic");
  }

  it("ignores a stale inventory response after close and reopen, then renders an empty result", async () => {
    const first = deferred<LocalRepositoryInventory>();
    const second = deferred<LocalRepositoryInventory>();
    const loadRepositories = vi
      .fn<NonNullable<OpenLocalRepositoryFormProps["loadRepositories"]>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    await renderForm({ loadRepositories });

    await click(findButton(container, "Open local repository"));
    expect(container.textContent).toContain("Reading repositories…");
    await click(findButton(container, "Close"));
    await click(findButton(container, "Open local repository"));
    await act(async () => {
      first.resolve({
        schemaVersion: 1,
        repositories: [
          { repositoryId, displayName: "stale repository", attachmentState: "unattached" },
        ],
      });
      await first.promise;
    });
    expect(container.textContent).not.toContain("stale repository");
    await act(async () => {
      second.resolve({ schemaVersion: 1, repositories: [] });
      await second.promise;
    });

    expect(loadRepositories).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("No authorized local repositories are available.");
  });

  it("copies commit suggestions only explicitly and explains the UTF-8 byte boundary", async () => {
    await openReadyForm();
    const intent = findControl(container, "Change Intent");
    const submit = findButton(container, "Retain Review Revision");

    expect(intent.value).toBe("");
    expect(submit.disabled).toBe(true);
    await click(findButton(container, "Use suggestion: Head source"));
    expect(intent.value).toBe("Head source");

    await changeValue(intent, "😀".repeat(5_001));
    expect(intent.getAttribute("aria-invalid")).toBe("true");
    expect(intent.getAttribute("aria-describedby")).toContain("intent-error");
    expect(container.textContent).toContain("20,004 / 20,000 UTF-8 bytes");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "20,000 UTF-8 bytes or fewer",
    );
    expect(submit.disabled).toBe(true);

    await changeValue(intent, "😀".repeat(5_000));
    expect(intent.getAttribute("aria-invalid")).toBeNull();
    expect(container.textContent).toContain("20,000 / 20,000 UTF-8 bytes");
    expect(submit.disabled).toBe(false);
  });

  it("disables dialog controls while pending, then resets and restores trigger focus", async () => {
    const retained = deferred<ReviewRevisionAvailable>();
    const retain = vi.fn(() => retained.promise);
    const onAvailable = vi.fn();
    await openReadyForm({ onAvailable, retain });
    await changeValue(findControl(container, "Change Intent"), "Review authorization boundaries");

    const form = container.querySelector("form");
    if (form === null) throw new Error("Retention form is unavailable");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(findButton(container, "Retaining…").disabled).toBe(true);
    expect(container.querySelector("fieldset")?.hasAttribute("disabled")).toBe(true);
    for (const control of container.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>(
      "dialog button, dialog textarea",
    )) {
      expect(control.disabled).toBe(true);
    }
    for (const control of container.querySelectorAll<HTMLSelectElement>("dialog select")) {
      if (control.closest("fieldset") === null) expect(control.disabled).toBe(true);
    }

    const available = { schemaVersion: 1 } as unknown as ReviewRevisionAvailable;
    await act(async () => {
      retained.resolve(available);
      await retained.promise;
    });
    const trigger = findButton(container, "Open local repository");
    expect(retain).toHaveBeenCalledWith(
      {
        repositoryId,
        baseRef: "refs/heads/main",
        headRef: "refs/heads/topic",
        changeIntent: "Review authorization boundaries",
      },
      expect.any(AbortSignal),
    );
    expect(onAvailable).toHaveBeenCalledWith(available);
    expect(container.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps the dialog retryable after a bounded retention failure", async () => {
    const retain = vi.fn(() =>
      Promise.reject(
        new ApiClientError(413, {
          schemaVersion: 1,
          code: "REVISION_LIMIT_EXCEEDED",
          message: "The exact revision exceeds the configured limit.",
          correlationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
        }),
      ),
    );
    await openReadyForm({ retain });
    await changeValue(findControl(container, "Change Intent"), "Review bounded retention");
    const form = container.querySelector("form");
    if (form === null) throw new Error("Retention form is unavailable");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("dialog")).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "The exact revision exceeds the configured limit.",
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "0c14b018-0260-4aa0-a5e9-61d212b948ce",
    );
    expect(findButton(container, "Retain Review Revision").disabled).toBe(false);
  });

  it("delegates authentication failures without showing a misleading repository error", async () => {
    const inventory = deferred<LocalRepositoryInventory>();
    const authenticationError = new Error("session expired");
    const onAuthenticationError = vi.fn(() => true);
    await renderForm({
      loadRepositories: () => inventory.promise,
      onAuthenticationError,
    });
    await click(findButton(container, "Open local repository"));
    await act(async () => {
      inventory.reject(authenticationError);
      await inventory.promise.catch(() => undefined);
    });

    expect(onAuthenticationError).toHaveBeenCalledWith(authenticationError);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
