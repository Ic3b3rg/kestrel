// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ChangeIntentVersionCreated,
  CreateChangeIntentVersionCommand,
  ProjectInbox,
} from "@kestrel/contracts";

import { ChangeIntentEditor, type ChangeIntentEditorProps } from "./ChangeIntentEditor.js";

type Proposal = ProjectInbox["projects"][number]["changeProposals"][number];

const projectId = "018f0f89-9a22-7864-aac2-8df71bf60420";
const providerProposal: Proposal = {
  author: null,
  base: { objectId: "a".repeat(40), ref: "main" },
  canonicalUrl: "https://github.com/kestrel/review-source/pull/42",
  changeIntent: null,
  changeIntentCandidates: [
    {
      id: "provider_title",
      kind: "provider_field",
      label: "GitHub title",
      text: "Keep repository access explicit",
      version: "2026-08-24T12:01:00.000Z",
      provenance: {
        canonicalUrl: "https://github.com/kestrel/review-source/pull/42",
        field: "title",
        kind: "provider_field",
        observedAt: "2026-08-24T12:01:00.000Z",
        provider: "github",
      },
    },
    {
      id: "head_commit_message",
      kind: "commit_message",
      label: "Head commit message",
      text: "Retain source-backed intent",
      version: "b".repeat(40),
      provenance: {
        kind: "commit_message",
        objectId: "b".repeat(40),
        ref: "review-source",
        side: "head",
      },
    },
  ],
  head: { objectId: "b".repeat(40), ref: "review-source" },
  id: "018f0f89-9192-755f-aa96-f72094c734dd",
  kind: "provider_observed",
  number: 42,
  observedAt: "2026-08-24T12:01:00.000Z",
  proposalState: "open",
  providerId: "PR_123",
  reviewRevisions: [],
  title: "Acquire exact source",
  version: 3,
};

function findControl<T extends HTMLInputElement | HTMLTextAreaElement>(
  container: HTMLElement,
  label: string,
): T {
  const element = [...container.querySelectorAll("label")].find((item) =>
    item.textContent?.includes(label),
  );
  const id = element?.htmlFor;
  const control = id === undefined || id === "" ? null : container.querySelector<T>(`#${id}`);
  if (control === null) throw new Error(`Control not found: ${label}`);
  return control;
}

async function changeValue(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked with the concrete control.
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter === undefined) throw new Error("Native value setter is unavailable");
  await act(async () => {
    setter.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function check(control: HTMLInputElement) {
  await act(async () => {
    control.click();
    await Promise.resolve();
  });
}

describe("ChangeIntentEditor", () => {
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

  async function renderEditor(overrides: Partial<ChangeIntentEditorProps> = {}) {
    await act(async () => {
      root.render(
        createElement(ChangeIntentEditor, {
          disabled: false,
          projectId,
          proposal: providerProposal,
          onCreated: vi.fn(),
          ...overrides,
        }),
      );
      await Promise.resolve();
    });
  }

  it("submits selected suggestions by ID while keeping provenance server-authored", async () => {
    const createVersion = vi.fn<
      (
        project: string,
        proposal: string,
        command: CreateChangeIntentVersionCommand,
        signal?: AbortSignal,
      ) => Promise<ChangeIntentVersionCreated>
    >(() => new Promise(() => undefined));
    await renderEditor({ createVersion });

    await check(findControl<HTMLInputElement>(container, "GitHub title"));
    await check(findControl<HTMLInputElement>(container, "Head commit message"));
    await changeValue(findControl(container, "Objective"), "Keep repository access read-only");
    await changeValue(findControl(container, "Scope boundaries"), "No provider writes\nNo secrets");
    await changeValue(
      findControl(container, "Ordered acceptance outcomes"),
      "Selected sources retain provenance\nThe proposal version advances",
    );
    await changeValue(findControl(container, "Operator input"), "Focus on local authority");
    const form = container.querySelector("form");
    if (form === null) throw new Error("Change Intent form is unavailable");

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(createVersion).toHaveBeenCalledWith(
      projectId,
      providerProposal.id,
      {
        acceptanceOutcomes: ["Selected sources retain provenance", "The proposal version advances"],
        expectedProposalVersion: 3,
        objective: "Keep repository access read-only",
        operatorInput: "Focus on local authority",
        scopeBoundaries: ["No provider writes", "No secrets"],
        selectedSourceIds: ["provider_title", "head_commit_message"],
        unresolvedIssues: [],
      },
      expect.any(AbortSignal),
    );
    expect(createVersion.mock.calls[0]?.[2]).not.toHaveProperty("selectedSources");
  });

  it("supports a provider-free resolved draft from Operator input alone", async () => {
    const localProposal: Proposal = {
      base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
      changeIntent: {
        acceptanceOutcomes: [],
        createdAt: "2026-08-24T12:00:30.000Z",
        id: "018f0f89-9a20-79f9-9990-dda80c9b917d",
        objective: "Review the boundary",
        resolution: {
          state: "unresolved",
          issues: [{ kind: "missing", field: "acceptance_outcomes" }],
        },
        scopeBoundaries: ["Local source only"],
        sourceDigest: "a".repeat(64),
        sources: [
          {
            id: "operator_input",
            kind: "operator_input",
            label: "Operator input",
            provenance: { kind: "operator_input" },
            text: "Review the boundary",
            version: "1",
          },
        ],
        text: "Review the boundary",
        version: 1,
      },
      changeIntentCandidates: [],
      createdAt: "2026-08-24T12:00:30.000Z",
      head: { objectId: "b".repeat(40), ref: "refs/heads/topic" },
      id: providerProposal.id,
      kind: "local",
      reviewRevisions: [],
      title: "Local change",
      updatedAt: "2026-08-24T12:01:00.000Z",
      version: 2,
    };
    const createVersion = vi.fn(() => new Promise<ChangeIntentVersionCreated>(() => undefined));
    await renderEditor({ createVersion, proposal: localProposal });

    expect(container.textContent).toContain("Unresolved");
    expect(container.textContent).toContain("Ordered acceptance outcomes are missing");
    await changeValue(
      findControl(container, "Ordered acceptance outcomes"),
      "Boundary is explicit",
    );
    const form = container.querySelector("form");
    if (form === null) throw new Error("Change Intent form is unavailable");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(createVersion).toHaveBeenCalledWith(
      projectId,
      localProposal.id,
      expect.objectContaining({
        expectedProposalVersion: 2,
        operatorInput: "Review the boundary",
        selectedSourceIds: [],
      }),
      expect.any(AbortSignal),
    );
  });
});
