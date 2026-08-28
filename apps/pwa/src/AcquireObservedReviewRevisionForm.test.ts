// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ProjectInbox,
  RetainObservedReviewRevisionCommand,
  ReviewRevisionAvailable,
} from "@kestrel/contracts";

import {
  AcquireObservedReviewRevisionForm,
  type AcquireObservedReviewRevisionFormProps,
} from "./AcquireObservedReviewRevisionForm.js";

type ProviderProposal = Extract<
  ProjectInbox["projects"][number]["changeProposals"][number],
  { kind: "provider_observed" }
>;

const proposal: ProviderProposal = {
  author: null,
  base: { objectId: "a".repeat(40), ref: "main" },
  canonicalUrl: "https://github.com/kestrel/review-source/pull/42",
  changeIntent: null,
  head: { objectId: "b".repeat(40), ref: "review-source" },
  id: "018f0f89-9192-755f-aa96-f72094c734dd",
  kind: "provider_observed",
  number: 42,
  observedAt: "2026-08-24T12:01:00.000Z",
  proposalState: "open",
  providerId: "PR_123",
  reviewRevisions: [],
  title: "Acquire exact source",
};
const projectId = "018f0f89-9a22-7864-aac2-8df71bf60420";

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (button === undefined) throw new Error(`Button not found: ${text}`);
  return button;
}

async function changeValue(control: HTMLTextAreaElement, value: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called below with the DOM control as its receiver.
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("Native value setter is unavailable");
  await act(async () => {
    setter.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("AcquireObservedReviewRevisionForm", () => {
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

  async function renderForm(
    overrides: Partial<AcquireObservedReviewRevisionFormProps> = {},
  ): Promise<void> {
    await act(async () => {
      root.render(
        createElement(AcquireObservedReviewRevisionForm, {
          disabled: false,
          projectId,
          proposal,
          onAvailable: vi.fn(),
          ...overrides,
        }),
      );
      await Promise.resolve();
    });
  }

  it("submits only opaque IDs and the confirmed Change Intent", async () => {
    const retained = deferred<ReviewRevisionAvailable>();
    const retain = vi.fn<
      (
        command: RetainObservedReviewRevisionCommand,
        signal?: AbortSignal,
      ) => Promise<ReviewRevisionAvailable>
    >(() => retained.promise);
    const onAvailable = vi.fn();
    await renderForm({ onAvailable, retain });
    const intent = container.querySelector<HTMLTextAreaElement>("textarea");
    const form = container.querySelector("form");
    if (intent === null || form === null)
      throw new Error("Observed acquisition form is unavailable");
    await changeValue(intent, "Review the exact authorization boundary");

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(findButton(container, "Acquiring…").disabled).toBe(true);
    expect(retain).toHaveBeenCalledWith(
      {
        projectId,
        changeProposalId: proposal.id,
        changeIntent: "Review the exact authorization boundary",
      },
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(retain.mock.calls[0]?.[0])).not.toMatch(
      /objectId|remote|ref|repository|url/iu,
    );

    const available = { schemaVersion: 1 } as unknown as ReviewRevisionAvailable;
    await act(async () => {
      retained.resolve(available);
      await retained.promise;
    });
    expect(onAvailable).toHaveBeenCalledWith(available);
  });

  it("prefills the last confirmed intent and renders an unavailable revision as a retry", async () => {
    await renderForm({
      proposal: {
        ...proposal,
        changeIntent: {
          createdAt: "2026-08-24T12:02:00.000Z",
          id: "018f0f89-9a20-79f9-9990-dda80c9b917d",
          text: "Review the retained boundary",
          version: 1,
        },
        reviewRevisions: [
          {
            availableAt: null,
            base: proposal.base,
            createdAt: "2026-08-24T12:02:00.000Z",
            failureReason: "object_missing",
            head: proposal.head,
            id: "018f0f89-9a21-7271-b92d-f1cb0d48bb47",
            objectCount: null,
            objectFormat: "sha1",
            retainedBytes: null,
            state: "unavailable",
          },
        ],
      },
    });

    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "Review the retained boundary",
    );
    expect(findButton(container, "Retry exact PR #42")).toBeDefined();
  });
});
