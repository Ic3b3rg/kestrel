// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInbox } from "@kestrel/contracts";

import { ExternalChangeIntentPanel } from "./ExternalChangeIntentPanel.js";

type Proposal = Extract<
  ProjectInbox["projects"][number]["changeProposals"][number],
  { kind: "provider_observed" }
>;

const proposal: Proposal = {
  author: { login: "octocat", providerId: "U_1" },
  base: { objectId: "a".repeat(40), ref: "main" },
  body: "Keep repository access explicit and reviewable.",
  canonicalUrl: "https://github.com/example/kestrel/pull/42",
  changeIntent: {
    acceptanceOutcomes: ["Repository access remains explicit"],
    createdAt: "2026-09-20T00:00:00.000Z",
    id: "018f0f89-9a20-79f9-9990-dda80c9b917d",
    objective: "Keep repository access explicit",
    resolution: { state: "resolved", issues: [] },
    scopeBoundaries: ["Pull request source access"],
    sourceDigest: "a".repeat(64),
    sources: [
      {
        id: "provider_title",
        kind: "provider_field",
        label: "GitHub title",
        provenance: {
          kind: "provider_field",
          provider: "github",
          field: "title",
          canonicalUrl: "https://github.com/example/kestrel/pull/42",
          observedAt: "2026-09-20T00:00:00.000Z",
        },
        text: "Keep repository access explicit",
        version: "1",
      },
    ],
    text: "Keep repository access explicit",
    version: 1,
  },
  changeIntentCandidates: [
    {
      id: "provider_title",
      kind: "provider_field",
      label: "GitHub title",
      provenance: {
        kind: "provider_field",
        provider: "github",
        field: "title",
        canonicalUrl: "https://github.com/example/kestrel/pull/42",
        observedAt: "2026-09-20T00:00:00.000Z",
      },
      text: "Keep repository access explicit",
      version: "1",
    },
  ],
  head: { objectId: "b".repeat(40), ref: "review-source" },
  id: "018f0f89-9192-755f-aa96-f72094c734dd",
  kind: "provider_observed",
  number: 42,
  observedAt: "2026-09-20T00:00:00.000Z",
  proposalState: "open",
  providerId: "PR_42",
  reviewRevisions: [],
  title: "Keep repository access explicit",
  version: 3,
};

describe("ExternalChangeIntentPanel", () => {
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

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("separates PR-stated purpose from operator confirmation without source checkboxes", async () => {
    const createVersion = vi.fn().mockResolvedValue({});
    const onCreated = vi.fn();
    act(() => {
      root.render(
        createElement(ExternalChangeIntentPanel, {
          createVersion,
          disabled: false,
          onCreated,
          projectId: "018f0f89-949a-75a8-8f61-6df78a843b1e",
          proposal,
        }),
      );
    });

    expect(container.textContent).toContain("What this change is meant to do");
    expect(container.textContent).toContain("Pull request stated");
    expect(container.textContent).toContain("You have not confirmed it");
    expect(container.textContent).toContain("Correct this explanation");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.textContent).not.toContain("PROPOSAL VERSION");

    const form = container.querySelector("form");
    if (form === null) throw new Error("Purpose correction form is unavailable");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(createVersion).toHaveBeenCalledWith(
      "018f0f89-949a-75a8-8f61-6df78a843b1e",
      proposal.id,
      {
        acceptanceOutcomes: ["Repository access remains explicit"],
        expectedProposalVersion: 3,
        objective: "Keep repository access explicit",
        operatorInput: "Operator confirmation: Keep repository access explicit",
        scopeBoundaries: ["Pull request source access"],
        selectedSourceIds: ["provider_title"],
        unresolvedIssues: [],
      },
      expect.any(AbortSignal),
    );
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("uses the concise GitHub title as the unconfirmed purpose and keeps the description secondary", () => {
    act(() => {
      root.render(
        createElement(ExternalChangeIntentPanel, {
          disabled: false,
          onCreated: vi.fn(),
          projectId: "018f0f89-949a-75a8-8f61-6df78a843b1e",
          proposal: { ...proposal, changeIntent: null },
        }),
      );
    });

    expect(container.querySelector(".text-base.font-medium")?.textContent).toBe(proposal.title);
    expect(container.querySelector("details summary")?.textContent).toContain("GitHub description");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(proposal.title);
  });
});
