import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ProjectInbox } from "@kestrel/contracts";

import { ProjectInboxPanel } from "./ProjectInboxPanel.js";

const populatedInbox: ProjectInbox = {
  schemaVersion: 1,
  projects: [
    {
      changeProposals: [
        {
          author: { login: "octocat", providerId: "U_kgDOA" },
          base: { objectId: "a".repeat(40), ref: "main" },
          canonicalUrl: "https://github.com/openai/openai-node/pull/1234",
          changeIntent: null,
          changeIntentCandidates: [],
          head: { objectId: "b".repeat(40), ref: "provider-observation" },
          id: "018f0f89-9192-755f-aa96-f72094c734dd",
          kind: "provider_observed",
          number: 1234,
          observedAt: "2026-08-24T12:01:00.000Z",
          proposalState: "open",
          providerId: "PR_kwDOGx",
          reviewRevisions: [],
          title: "Keep repository access explicit",
          version: 1,
        },
      ],
      createdAt: "2026-08-24T12:00:00.000Z",
      id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
      localRepositorySource: null,
      modelAccess: "not_configured",
      providerObservation: {
        authentication: "none",
        kind: "public_github",
        refresh: "manual",
      },
      repository: {
        canonicalUrl: "https://github.com/openai/openai-node",
        name: "openai-node",
        owner: "openai",
        providerId: "R_kgDOGx",
      },
      sourceAvailability: "not_acquired",
      updatedAt: "2026-08-24T12:01:00.000Z",
    },
  ],
};

const localInbox: ProjectInbox = {
  schemaVersion: 1,
  projects: [
    {
      changeProposals: [
        {
          kind: "local",
          id: "018f0f89-9192-755f-aa96-f72094c734dd",
          version: 1,
          title: "Review local authorization changes",
          base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
          head: { objectId: "b".repeat(40), ref: "refs/heads/review-source" },
          changeIntent: {
            acceptanceOutcomes: [],
            id: "018f0f89-9a20-79f9-9990-dda80c9b917d",
            objective: "Review the authorization boundary.",
            resolution: {
              state: "unresolved",
              issues: [
                { kind: "missing", field: "scope_boundaries" },
                { kind: "missing", field: "acceptance_outcomes" },
              ],
            },
            scopeBoundaries: [],
            sourceDigest: "a".repeat(64),
            sources: [
              {
                id: "operator_input",
                kind: "operator_input",
                label: "Operator input",
                provenance: { kind: "operator_input" },
                text: "Review the authorization boundary.",
                version: "1",
              },
            ],
            version: 1,
            text: "Review the authorization boundary.",
            createdAt: "2026-08-24T12:00:30.000Z",
          },
          changeIntentCandidates: [],
          reviewRevisions: [
            {
              id: "018f0f89-9a21-7271-b92d-f1cb0d48bb47",
              state: "available",
              objectFormat: "sha1",
              base: { objectId: "a".repeat(40), ref: "refs/heads/main" },
              head: { objectId: "b".repeat(40), ref: "refs/heads/review-source" },
              objectCount: 7,
              retainedBytes: 4096,
              failureReason: null,
              createdAt: "2026-08-24T12:00:30.000Z",
              availableAt: "2026-08-24T12:01:00.000Z",
            },
          ],
          createdAt: "2026-08-24T12:00:30.000Z",
          updatedAt: "2026-08-24T12:01:00.000Z",
        },
      ],
      createdAt: "2026-08-24T12:00:00.000Z",
      id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
      localRepositorySource: {
        id: "018f0f89-9a1d-7484-b224-866ef9d69990",
        repositoryId: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
        displayName: "kestrel",
        state: "attached",
        objectFormat: "sha1",
        createdAt: "2026-08-24T12:00:00.000Z",
        updatedAt: "2026-08-24T12:01:00.000Z",
      },
      modelAccess: "not_configured",
      providerObservation: null,
      repository: null,
      sourceAvailability: "available",
      updatedAt: "2026-08-24T12:01:00.000Z",
    },
  ],
};

function render(inbox: ProjectInbox | null, loading = false): string {
  return renderToStaticMarkup(
    createElement(ProjectInboxPanel, {
      error: null,
      inbox,
      loading,
      online: true,
      pending: false,
      onOpen: vi.fn(),
      onRetry: vi.fn(),
    }),
  );
}

describe("ProjectInboxPanel", () => {
  it("keeps the local command enabled while a populated inbox refreshes in the background", () => {
    const html = render(populatedInbox, true);

    expect(html).toContain('<button type="button">Open local repository</button>');
  });

  it("explains the credential-free public GitHub path when the inbox is empty", () => {
    const html = render({ schemaVersion: 1, projects: [] });

    expect(html).toContain("Optional public GitHub pull request URL");
    expect(html).toContain("GitHub metadata does not by itself authorize or acquire review source");
    expect(html).toContain("No GitHub credentials are sent or stored");
    expect(html).toContain("No Projects yet");
    expect(html).toContain("60 unauthenticated GitHub API requests per hour");
  });

  it("renders Provider Observation, source, and model access as separate facts", () => {
    const html = render(populatedInbox);

    expect(html).toContain("openai/openai-node");
    expect(html).toContain("#1234 · Keep repository access explicit");
    expect(html).toContain("Source");
    expect(html).toContain("Not acquired");
    expect(html).toContain("Provider observation");
    expect(html).toContain("Public GitHub pull request");
    expect(html).toContain("Refresh");
    expect(html).toContain("Manual only");
    expect(html).not.toContain("Synchronization");
    expect(html).toContain("Model access");
    expect(html).toContain("Not configured");
    expect(html).toContain("Observed base");
    expect(html).toContain("Observed head");
    expect(html).not.toContain("Base revision");
    expect(html).toContain("Refresh PR #1234");
  });

  it("renders local source, provider metadata, Revision State, and model access separately", () => {
    const html = render(localInbox);

    expect(html).toContain("Open local repository");
    expect(html.indexOf("Open local repository")).toBeLessThan(
      html.indexOf("Optional public GitHub pull request URL"),
    );
    expect(html).toContain("Local Repository Source");
    expect(html).toContain("kestrel");
    expect(html).toContain("Attached");
    expect(html).toContain("Provider metadata");
    expect(html).toContain("Not observed");
    expect(html).toContain("Revision State");
    expect(html).toContain("Source availability");
    expect(html).toContain("Available");
    expect(html).toContain("Review the authorization boundary.");
    expect(html).toContain("Change Intent v1");
    expect(html).toContain("Model access");
    expect(html).not.toContain("/private/");
  });

  it("labels an authenticated host observation without claiming public anonymous access", () => {
    const project = populatedInbox.projects[0];
    if (project === undefined) throw new Error("Provider fixture is unavailable");
    const html = render({
      schemaVersion: 1,
      projects: [
        {
          ...project,
          providerObservation: {
            kind: "host_gh",
            authentication: "host_session",
            refresh: "manual",
            host: "github.com",
            account: "operator",
          },
        },
      ],
    });
    expect(html).toContain("GITHUB / HOST SESSION");
    expect(html).toContain("GitHub through host session");
    expect(html).toContain("operator on github.com");
    expect(html).not.toContain("PUBLIC GITHUB / NO AUTHENTICATION");
  });

  it("renders retained revision facts on an enriched provider proposal", () => {
    const project = populatedInbox.projects[0];
    const proposal = project?.changeProposals[0];
    const localProject = localInbox.projects[0];
    const localProposal = localProject?.changeProposals[0];
    if (
      project === undefined ||
      proposal === undefined ||
      !("providerId" in proposal) ||
      localProject?.localRepositorySource == null ||
      localProposal === undefined
    ) {
      throw new Error("Provider fixture is unavailable");
    }
    const enriched: ProjectInbox = {
      schemaVersion: 1,
      projects: [
        {
          ...project,
          localRepositorySource: localProject.localRepositorySource,
          sourceAvailability: "available",
          changeProposals: [
            {
              ...proposal,
              base: { ...proposal.base, objectId: "c".repeat(40) },
              changeIntent: localProposal.changeIntent,
              head: { ...proposal.head, objectId: "d".repeat(40) },
              reviewRevisions: localProposal.reviewRevisions,
            },
          ],
        },
      ],
    };

    const html = render(enriched);
    expect(html).toContain("Review the authorization boundary.");
    expect(html).toContain("Revision State");
    expect(html).toContain("Available");
    expect(html).toContain("Observed base");
    expect(html).toContain("Retained base");
    expect(html).toContain("Change Intent v1");
    expect(html).toContain(">cccccccccccc</code>");
    expect(html).toContain(">aaaaaaaaaaaa</code>");
    expect(html).toContain("c".repeat(40));
    expect(html).toContain("a".repeat(40));
  });

  it("offers exact observed-PR acquisition only when a local source is attached", () => {
    const project = populatedInbox.projects[0];
    const localSource = localInbox.projects[0]?.localRepositorySource;
    if (project === undefined || localSource === null || localSource === undefined) {
      throw new Error("Attached provider fixture is unavailable");
    }
    const html = render({
      schemaVersion: 1,
      projects: [{ ...project, localRepositorySource: localSource }],
    });

    expect(html).toContain("Confirm Change Intent for PR #1234");
    expect(html).toContain("Acquire exact PR #1234");
    expect(html).toContain("host credential helper");
    expect(render(populatedInbox)).not.toContain("Acquire exact PR #1234");
  });

  it("renders an unavailable revision as retryable without claiming an artifact was retained", () => {
    const project = localInbox.projects[0];
    const proposal = project?.changeProposals[0];
    const revision = proposal?.reviewRevisions[0];
    if (project === undefined || proposal?.kind !== "local" || revision === undefined) {
      throw new Error("Local unavailable revision fixture is unavailable");
    }
    const unavailable: ProjectInbox = {
      schemaVersion: 1,
      projects: [
        {
          ...project,
          sourceAvailability: "unavailable",
          changeProposals: [
            {
              ...proposal,
              reviewRevisions: [
                {
                  ...revision,
                  state: "unavailable",
                  objectCount: null,
                  retainedBytes: null,
                  failureReason: "revision_limit_exceeded",
                  availableAt: null,
                },
              ],
            },
          ],
        },
      ],
    };

    const html = render(unavailable);
    expect(html).toContain("Revision base");
    expect(html).toContain("Revision head");
    expect(html).not.toContain("Retained base");
    expect(html).toContain("configured revision size or object limit was exceeded");
    expect(html).toContain("Adjust the configured revision limits before retrying");
  });

  it("gives an actionable provider-authentication failure without exposing provider details", () => {
    const project = localInbox.projects[0];
    const proposal = project?.changeProposals[0];
    const revision = proposal?.reviewRevisions[0];
    if (project === undefined || proposal?.kind !== "local" || revision === undefined) {
      throw new Error("Local unavailable revision fixture is unavailable");
    }
    const html = render({
      schemaVersion: 1,
      projects: [
        {
          ...project,
          sourceAvailability: "unavailable",
          changeProposals: [
            {
              ...proposal,
              reviewRevisions: [
                {
                  ...revision,
                  state: "unavailable",
                  objectCount: null,
                  retainedBytes: null,
                  failureReason: "provider_authentication_required",
                  availableAt: null,
                },
              ],
            },
          ],
        },
      ],
    });

    expect(html).toContain("Host Git authentication is required for this repository");
    expect(html).toContain("Restore host Git authentication or SSO access");
    expect(html).not.toContain("stderr");
  });
});
