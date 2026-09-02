import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

import {
  ProjectInboxSchema,
  ReviewRevisionAvailableSchema,
  type ChangeIntentVersionCreated,
  type HostGitHubConnection,
  type ProjectUpserted,
} from "@kestrel/contracts";

import { startStack, TEST_OPERATOR_CREDENTIALS, type RunningStack } from "./support/compose.js";

const publicPullRequestUrl = "https://github.com/Ic3b3rg/kestrel/pull/88";
const openedProject: ProjectUpserted = {
  schemaVersion: 1,
  project: {
    changeProposals: [
      {
        author: { login: "Ic3b3rg", providerId: "U_kestrel" },
        base: { objectId: "c".repeat(40), ref: "master" },
        canonicalUrl: publicPullRequestUrl,
        changeIntent: null,
        changeIntentCandidates: [],
        head: { objectId: "d".repeat(40), ref: "operator-security" },
        id: "018f0f89-9192-755f-aa96-f72094c734df",
        kind: "provider_observed",
        number: 88,
        observedAt: "2026-08-25T12:01:00.000Z",
        proposalState: "merged",
        providerId: "PR_kestrel",
        reviewRevisions: [],
        title: "Secure and recover the Operator",
        version: 1,
      },
    ],
    createdAt: "2026-08-25T12:00:00.000Z",
    id: "018f0f89-949a-75a8-8f61-6df78a843b1f",
    localRepositorySource: null,
    modelAccess: "not_configured",
    providerObservation: {
      authentication: "none",
      kind: "public_github",
      refresh: "manual",
    },
    repository: {
      canonicalUrl: "https://github.com/Ic3b3rg/kestrel",
      name: "kestrel",
      owner: "Ic3b3rg",
      providerId: "R_kestrel",
    },
    sourceAvailability: "not_acquired",
    updatedAt: "2026-08-25T12:01:00.000Z",
  },
};

async function openProjectWorkspace(page: Page, label = "openai/openai-node"): Promise<void> {
  const link = page
    .getByRole("navigation", { name: "Projects" })
    .getByRole("link", { name: new RegExp(label.replace("/", "\\/"), "u") });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.getByRole("heading", { level: 1, name: label, exact: true })).toBeVisible();
}

test.describe("observable Installation PWA", () => {
  let stack: RunningStack | undefined;

  test.beforeAll(async () => {
    stack = await startStack();
    await stack.authenticateOperator(TEST_OPERATOR_CREDENTIALS);
    await stack.executeRuntimeSql(`
      WITH project AS (
        INSERT INTO projects (
          installation_id,
          provider_observation_kind,
          provider,
          provider_repository_id,
          repository_owner_snapshot,
          repository_name_snapshot,
          repository_canonical_url_snapshot
        )
        SELECT id,
               'public_github',
               'github',
               'R_kgDOGx',
               'openai',
               'openai-node',
               'https://github.com/openai/openai-node'
        FROM installations
        RETURNING id
      )
      INSERT INTO change_proposals (
        project_id,
        provider_proposal_id,
        provider_number,
        title_snapshot,
        canonical_url_snapshot,
        proposal_state,
        base_ref_snapshot,
        base_object_id,
        head_ref_snapshot,
        head_object_id,
        author_provider_id,
        author_login_snapshot
      )
      SELECT id,
             'PR_kwDOGx',
             1234,
             'Keep repository access explicit',
             'https://github.com/openai/openai-node/pull/1234',
             'open',
             'main',
             '${"a".repeat(40)}',
             'provider-observation',
             '${"b".repeat(40)}',
             'U_kgDOA',
             'octocat'
      FROM project;
    `);
  });

  test.afterAll(async () => {
    await stack?.close();
  });

  test.afterEach(async () => {
    await stack?.executeSql(`
      DELETE FROM local_repository_sources
      WHERE source_identity = '${"e".repeat(64)}';
    `);
  });

  test("the Project shows an attributable Direct API profile without credential details", async ({
    page,
  }) => {
    if (stack === undefined) throw new Error("Direct API profile browser stack is unavailable");
    const runningStack = stack;
    await runningStack.executeRuntimeSql(`
      INSERT INTO direct_api_profiles (
        project_id,
        credential_handle,
        display_name,
        organization_id,
        openai_project_id,
        requested_model_id,
        expected_resolved_model_id,
        data_policy,
        attestation_expires_at,
        limits,
        price_snapshot,
        profile_digest,
        availability,
        availability_reasons,
        attributed_openai_project_id,
        observed_api_version,
        observed_model,
        observed_organization_id,
        synthetic_request_id,
        last_test_passed_at,
        created_at,
        updated_at
      )
      SELECT id,
             'cred_abcdefghijklmnopqrstuvwxyzABCDEFGH123456789',
             'OpenAI direct review',
             'org_example',
             'proj_example',
             'gpt-test-2026-08-01',
             'gpt-test-2026-08-01',
             '{"abuseMonitoring":"modified","attestedAt":"2026-08-31T12:00:00.000Z","evidenceUrl":"https://developers.openai.com/api/docs/guides/your-data","expiresAt":"2099-09-30T12:00:00.000Z","humanReview":"restricted","processingRegions":["US"],"storageRegions":["US"],"trainingUse":"not_used_without_opt_in"}'::jsonb,
             '2099-09-30T12:00:00.000Z',
             '{"maximumAttempts":1,"maximumConcurrentRequests":1,"maximumCostUsd":"2.500000","maximumInputTokens":100000,"maximumOutputTokens":8192,"maximumRequestBytes":1048576,"requestTimeoutMilliseconds":60000}'::jsonb,
             '{"cachedInputPerMillionTokensUsd":"0.125000","capturedAt":"2026-08-31T12:00:00.000Z","currency":"USD","effectiveAt":"2026-08-01T00:00:00.000Z","inputPerMillionTokensUsd":"1.250000","outputPerMillionTokensUsd":"10.000000","sourceUrl":"https://developers.openai.com/api/docs/pricing"}'::jsonb,
             '${"6".repeat(64)}',
             'available',
             '[]'::jsonb,
             'proj_example',
             '2020-10-01',
             'gpt-test-2026-08-01',
             'org_example',
             'req_synthetic_example',
             clock_timestamp(),
             clock_timestamp(),
             clock_timestamp()
      FROM projects
      WHERE provider_repository_id = 'R_kgDOGx';
    `);

    try {
      const browserErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning") {
          const text = message.text();
          if (
            text !==
            "Failed to load resource: the server responded with a status of 401 (Unauthorized)"
          ) {
            browserErrors.push(text);
          }
        }
      });
      page.on("pageerror", (error) => browserErrors.push(error.message));
      await page.goto(runningStack.pwaUrl);
      await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
      await page.getByLabel("Password").fill(TEST_OPERATOR_CREDENTIALS.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await openProjectWorkspace(page);

      const panel = page.locator(".direct-api-profile");
      await expect(panel.getByRole("heading", { name: "Direct API profile" })).toBeVisible();
      await expect(panel.getByRole("status")).toContainText("Available");
      await expect(panel).toContainText("https://api.openai.com/v1/responses");
      await expect(panel).toContainText("gpt-test-2026-08-01");
      await expect(panel).toContainText("org_example");
      await expect(panel).toContainText("proj_example");
      await expect(panel).toContainText("Not used without opt-in");
      await expect(panel).not.toContainText("credential_handle");
      await expect(panel).not.toContainText("cred_abcdefghijklmnopqrstuvwxyz");
      await expect(panel).not.toContainText("sk-");

      await panel.getByRole("button", { name: "Replace profile" }).click();
      await expect(panel.getByLabel("Current Operator password")).toHaveAttribute(
        "type",
        "password",
      );
      await expect(panel.getByLabel("Project-exclusive OpenAI key")).toHaveAttribute(
        "type",
        "password",
      );
      const accessibility = await new AxeBuilder({ page }).include(".direct-api-profile").analyze();
      expect(accessibility.violations).toEqual([]);

      await page.setViewportSize({ height: 900, width: 320 });
      await expect(panel).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      expect(browserErrors).toEqual([]);
    } finally {
      await runningStack.executeSql("DELETE FROM direct_api_profiles;");
    }
  });

  test("the Operator acquires an observed pull request from its Project", async ({ page }) => {
    if (stack === undefined) throw new Error("Observed pull-request browser stack is unavailable");
    const runningStack = stack;
    await runningStack.executeRuntimeSql(`
      INSERT INTO local_repository_sources (
        installation_id,
        project_id,
        source_identity,
        repository_id,
        root_id,
        repository_relative_locator,
        display_name_snapshot,
        object_format,
        github_owner_snapshot,
        github_name_snapshot,
        attachment_state
      )
      SELECT installation_id,
             id,
             '${"e".repeat(64)}',
             '018f0f89-9a1e-7d64-a5dd-18cc3e317401',
             '018f0f89-9a1f-72ae-82c4-ef8ee27d6932',
             'openai-node',
             'openai-node',
             'sha1',
             'openai',
             'openai-node',
             'attached'
      FROM projects
      WHERE provider_repository_id = 'R_kgDOGx';
    `);
    const inbox = ProjectInboxSchema.parse(
      await (await runningStack.fetchApi("/api/v1/projects")).json(),
    );
    const project = inbox.projects.find(
      (candidate) => candidate.repository?.name === "openai-node",
    );
    const proposal = project?.changeProposals.find(
      (candidate) => candidate.kind === "provider_observed" && candidate.number === 1234,
    );
    if (project === undefined || proposal?.kind !== "provider_observed") {
      throw new Error("Observed pull-request browser fixture is unavailable");
    }
    if (project.localRepositorySource === null) {
      throw new Error("Observed pull-request browser source is unavailable");
    }
    const changeIntentText = "Review the exact provider-observed pull request revision";
    const acquisitionChangeIntent = {
      acceptanceOutcomes: [],
      createdAt: "2026-08-28T12:05:00.000Z",
      id: "018f0f89-9a25-7d63-b6f7-108b7b4bf52f",
      objective: changeIntentText,
      resolution: {
        state: "unresolved" as const,
        issues: [
          { kind: "missing" as const, field: "scope_boundaries" as const },
          { kind: "missing" as const, field: "acceptance_outcomes" as const },
        ],
      },
      scopeBoundaries: [],
      sourceDigest: "a".repeat(64),
      sources: [
        {
          id: "operator_input",
          kind: "operator_input" as const,
          label: "Operator input",
          provenance: { kind: "operator_input" as const },
          text: changeIntentText,
          version: "1",
        },
      ],
      text: changeIntentText,
      version: 1,
    };
    const reviewRevision = {
      availableAt: "2026-08-28T12:05:01.000Z",
      base: proposal.base,
      createdAt: "2026-08-28T12:05:00.000Z",
      failureReason: null,
      head: proposal.head,
      id: "018f0f89-9a26-7d63-b6f7-108b7b4bf52f",
      objectCount: 8,
      objectFormat: project.localRepositorySource.objectFormat,
      retainedBytes: 923,
      state: "available" as const,
    };
    const availableProposal = {
      ...proposal,
      changeIntent: acquisitionChangeIntent,
      reviewRevisions: [reviewRevision],
    };
    const availableProject = {
      ...project,
      changeProposals: project.changeProposals.map((candidate) =>
        candidate.id === proposal.id ? availableProposal : candidate,
      ),
      sourceAvailability: "available" as const,
      updatedAt: "2026-08-28T12:05:01.000Z",
    };
    const available = ReviewRevisionAvailableSchema.parse({
      schemaVersion: 1,
      acquisitionChangeIntent,
      changeProposal: availableProposal,
      localRepositorySource: project.localRepositorySource,
      project: availableProject,
      reviewRevision,
    });

    let acquired = false;
    await page.route("**/api/v1/projects", async (route: Route) => {
      if (route.request().method() === "GET" && acquired) {
        await route.fulfill({ json: { schemaVersion: 1, projects: [available.project] } });
        return;
      }
      await route.continue();
    });
    await page.route("**/api/v1/projects/*/provider/github", async (route: Route) => {
      await route.fulfill({
        json: {
          schemaVersion: 1,
          projectId: project.id,
          route: "host_gh",
          limitations: ["The observed-acquisition browser test does not exercise host gh."],
          status: {
            executableVersion: null,
            availability: "unavailable",
            host: "github.com",
            authentication: "unknown",
            account: null,
          },
          groupStates: [
            {
              group: "review_requested",
              state: "unavailable",
              failureReason: "unexpected_response",
            },
            {
              group: "authored",
              state: "unavailable",
              failureReason: "unexpected_response",
            },
            {
              group: "other",
              state: "unavailable",
              failureReason: "unexpected_response",
            },
          ],
          pullRequests: [],
          observedAt: "2026-08-28T12:00:00.000Z",
        },
        status: 200,
      });
    });
    let markRequestObserved: () => void = () => undefined;
    const requestObserved = new Promise<void>((resolve) => {
      markRequestObserved = resolve;
    });
    let releaseResponse: () => void = () => undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    await page.route("**/api/v1/review-revisions", async (route: Route) => {
      const request = route.request();
      if (request.method() !== "POST") {
        await route.continue();
        return;
      }
      const command: unknown = request.postDataJSON();
      expect(command).toEqual({
        changeIntent: changeIntentText,
        changeProposalId: proposal.id,
        projectId: project.id,
      });
      expect(Object.keys(command as Record<string, unknown>).sort()).toEqual([
        "changeIntent",
        "changeProposalId",
        "projectId",
      ]);
      expect(request.headers()["x-kestrel-csrf"]).toBeTruthy();
      expect(request.headers().authorization).toBeUndefined();
      markRequestObserved();
      await responseGate;
      acquired = true;
      await route.fulfill({ json: available, status: 201 });
    });

    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        const text = message.text();
        if (
          text !==
          "Failed to load resource: the server responded with a status of 401 (Unauthorized)"
        ) {
          browserErrors.push(text);
        }
      }
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.goto(runningStack.pwaUrl);
    await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
    await page.getByLabel("Password").fill(TEST_OPERATOR_CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await openProjectWorkspace(page);
    await expect(page.getByText("Credentials stay with host Git", { exact: true })).toBeVisible();
    const intent = page.getByLabel("Confirm Change Intent for PR #1234");
    await expect(intent).toHaveValue("");
    await expect(page.getByRole("button", { name: "Acquire exact PR #1234" })).toBeDisabled();
    await expect(page.getByText(/host credential helper/u)).toBeVisible();
    await expect(page.getByText(/never receives or stores the credential/u)).toBeVisible();
    await intent.fill(changeIntentText);
    const acquire = page.getByRole("button", { name: "Acquire exact PR #1234" });
    await acquire.click();
    await requestObserved;
    await expect(page.getByRole("button", { name: "Acquiring…" })).toBeDisabled();
    await expect(intent).toBeDisabled();
    releaseResponse();
    await expect(page.getByRole("status")).toContainText("The exact Review Revision is available.");
    await expect(page.getByRole("button", { name: "Acquire exact PR #1234" })).toHaveCount(0);
    await expect(page.getByRole("definition").filter({ hasText: changeIntentText })).toBeVisible();
    await expect(page.getByText("Available", { exact: true })).toHaveCount(2);
    const accessibility = await new AxeBuilder({ page }).include(".projects-section").analyze();
    expect(accessibility.violations).toEqual([]);
    expect(browserErrors).toEqual([]);
  });

  test("the Operator curates a source-backed Change Intent version", async ({ page }) => {
    if (stack === undefined) throw new Error("Change Intent browser stack is unavailable");
    const runningStack = stack;
    const inbox = ProjectInboxSchema.parse(
      await (await runningStack.fetchApi("/api/v1/projects")).json(),
    );
    const project = inbox.projects.find(
      (candidate) => candidate.repository?.name === "openai-node",
    );
    const proposal = project?.changeProposals.find(
      (candidate) => candidate.kind === "provider_observed" && candidate.number === 1234,
    );
    const source = proposal?.changeIntentCandidates.find(({ id }) => id === "provider_title");
    if (project === undefined || proposal === undefined || source === undefined) {
      throw new Error("Change Intent browser fixture is unavailable");
    }
    const objective = "Keep repository access explicit and read-only";
    const command = {
      acceptanceOutcomes: ["The selected source remains attributable"],
      expectedProposalVersion: proposal.version,
      objective,
      operatorInput: "Prioritize the local authorization boundary",
      scopeBoundaries: ["Do not add provider write authority"],
      selectedSourceIds: [source.id],
      unresolvedIssues: [],
    };
    const created: ChangeIntentVersionCreated = {
      schemaVersion: 1,
      projectId: project.id,
      changeProposalId: proposal.id,
      proposalVersion: proposal.version + 1,
      changeIntent: {
        acceptanceOutcomes: command.acceptanceOutcomes,
        createdAt: "2026-08-28T12:04:00.000Z",
        id: "018f0f89-9a24-7d63-b6f7-108b7b4bf52f",
        objective,
        resolution: { state: "resolved", issues: [] },
        scopeBoundaries: command.scopeBoundaries,
        sourceDigest: "f".repeat(64),
        sources: [
          source,
          {
            id: "operator_input",
            kind: "operator_input",
            label: "Operator input",
            provenance: { kind: "operator_input" },
            text: command.operatorInput,
            version: "1",
          },
        ],
        text: objective,
        version: 1,
      },
    };
    const updatedProject = {
      ...project,
      changeProposals: project.changeProposals.map((candidate) =>
        candidate.id === proposal.id
          ? {
              ...candidate,
              changeIntent: created.changeIntent,
              version: created.proposalVersion,
            }
          : candidate,
      ),
    };
    let saved = false;
    await page.route("**/api/v1/projects", async (route) => {
      if (route.request().method() === "GET" && saved) {
        await route.fulfill({ json: { schemaVersion: 1, projects: [updatedProject] } });
        return;
      }
      await route.continue();
    });
    await page.route("**/api/v1/projects/*/change-proposals/*/change-intents", async (route) => {
      const request = route.request();
      expect(request.method()).toBe("POST");
      expect(request.postDataJSON()).toEqual(command);
      expect(Object.keys(request.postDataJSON() as Record<string, unknown>).sort()).toEqual([
        "acceptanceOutcomes",
        "expectedProposalVersion",
        "objective",
        "operatorInput",
        "scopeBoundaries",
        "selectedSourceIds",
        "unresolvedIssues",
      ]);
      expect(request.headers()["x-kestrel-csrf"]).toBeTruthy();
      saved = true;
      await route.fulfill({ json: created, status: 201 });
    });

    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        const text = message.text();
        if (
          text !==
          "Failed to load resource: the server responded with a status of 401 (Unauthorized)"
        ) {
          browserErrors.push(text);
        }
      }
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.goto(runningStack.pwaUrl);
    await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
    await page.getByLabel("Password").fill(TEST_OPERATOR_CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await openProjectWorkspace(page);
    await expect(page.getByText("Unresolved draft", { exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: /GitHub title/u }).check();
    await page.getByLabel("Objective", { exact: true }).fill(objective);
    await page.getByLabel(/Scope boundaries/u).fill("Do not add provider write authority");
    await page
      .getByLabel(/Ordered acceptance outcomes/u)
      .fill("The selected source remains attributable");
    await page
      .getByLabel("Operator input", { exact: true })
      .fill("Prioritize the local authorization boundary");
    await expect(page.getByText("Ready to resolve", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create Change Intent version" }).click();

    await expect(page.getByRole("status")).toContainText(
      "Change Intent version 1 created as resolved.",
    );
    await expect(page.getByText("Current v1", { exact: true })).toBeVisible();
    await expect(page.getByText(`Source digest ${"f".repeat(64)}`, { exact: true })).toBeVisible();
    await expect(page.getByText("Resolved", { exact: true })).toBeVisible();
    await expect(page.getByText("Work Item", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Planning Session", { exact: true })).toHaveCount(0);
    const accessibility = await new AxeBuilder({ page }).include(".change-intent-editor").analyze();
    expect(accessibility.violations).toEqual([]);
    expect(browserErrors).toEqual([]);
  });

  test("the Operator runs and observes a diagnostic", async ({ context, page }) => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    const browserErrors: string[] = [];
    let expectedUnauthorizedResponses = 2;
    let expectedServiceUnavailableResponses = 0;
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        const text = message.text();
        if (
          expectedUnauthorizedResponses > 0 &&
          text ===
            "Failed to load resource: the server responded with a status of 401 (Unauthorized)"
        ) {
          expectedUnauthorizedResponses -= 1;
        } else if (
          expectedServiceUnavailableResponses > 0 &&
          text ===
            "Failed to load resource: the server responded with a status of 503 (Service Unavailable)"
        ) {
          expectedServiceUnavailableResponses -= 1;
        } else {
          browserErrors.push(text);
        }
      }
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));
    let projectPostCount = 0;
    await page.route(
      `**/api/v1/projects/${openedProject.project.id}/model-profiles/direct-api`,
      async (route) => {
        await route.fulfill({ json: { profile: null, schemaVersion: 1 }, status: 200 });
      },
    );
    await page.route("**/api/v1/projects", async (route) => {
      const request = route.request();
      if (request.method() !== "POST") {
        await route.continue();
        return;
      }
      projectPostCount += 1;
      expect(request.postDataJSON()).toEqual({ url: publicPullRequestUrl });
      expect(request.headers()["x-kestrel-csrf"]).toBeTruthy();
      expect(request.headers().authorization).toBeUndefined();
      await route.fulfill({ json: openedProject, status: 200 });
    });

    let connectionProbeCount = 0;
    let connectionActionRequired = false;
    let connectionProbeBlocked = true;
    let releaseFirstConnectionProbe: () => void = () => undefined;
    const firstConnectionProbeGate = new Promise<void>((resolve) => {
      releaseFirstConnectionProbe = resolve;
    });
    await page.route("**/api/v1/connections/github*", async (route) => {
      connectionProbeCount += 1;
      if (connectionProbeBlocked) await firstConnectionProbeGate;
      const selectedProjectId = new URL(route.request().url()).searchParams.get("projectId");
      const selectedRepository =
        selectedProjectId === openedProject.project.id
          ? { owner: "Ic3b3rg", name: "kestrel" }
          : { owner: "openai", name: "openai-node" };
      const connection: HostGitHubConnection = connectionActionRequired
        ? {
            schemaVersion: 1,
            state: "action_required",
            reason: "authentication_required",
            cli: { version: "2.87.0", supported: true },
            identity: null,
            projectAccess:
              selectedProjectId === null
                ? null
                : { state: "not_verified", projectId: selectedProjectId, repository: null },
            checkedAt: "2026-09-02T12:01:00.000Z",
          }
        : {
            schemaVersion: 1,
            state: "ready",
            reason: null,
            cli: { version: "2.87.0", supported: true },
            identity: { host: "github.com", account: "operator" },
            projectAccess:
              selectedProjectId === null
                ? null
                : {
                    state: "verified",
                    projectId: selectedProjectId,
                    repository: selectedRepository,
                  },
            checkedAt: "2026-09-02T12:00:00.000Z",
          };
      await route.fulfill({ json: connection, status: 200 });
    });

    await page.goto(runningStack.pwaUrl);
    await expect(page.getByRole("heading", { name: "Sign in to Kestrel" })).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to sign in" })).toBeFocused();
    const loginAccessibility = await new AxeBuilder({ page }).analyze();
    expect(loginAccessibility.violations).toEqual([]);
    await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
    const passwordInput = page.getByLabel("Password");
    await passwordInput.fill("not the Operator password");
    await page.getByRole("button", { name: "Sign in" }).click();
    const loginError = page.getByRole("alert");
    await expect(loginError).toContainText("The Operator credentials are invalid");
    await expect(loginError).toBeFocused();
    await expect(passwordInput).toHaveValue("");
    await passwordInput.fill(TEST_OPERATOR_CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Projects", exact: true }),
    ).toBeVisible();
    expectedUnauthorizedResponses = 0;
    await openProjectWorkspace(page);
    await expect(page.getByText("Not acquired", { exact: true })).toHaveCount(2);
    await expect(page.getByText("Public GitHub pull request", { exact: true })).toBeVisible();
    await expect(page.getByText(/Refresh is Manual only/u)).toBeVisible();
    await expect(page.getByText("Not configured", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh PR #1234" })).toBeVisible();
    await page
      .getByLabel("Optional public GitHub pull request URL")
      .fill("https://github.com/openai/openai-node");
    await page.getByRole("button", { name: "Add provider context" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Enter a canonical public pull request URL",
    );
    expect(projectPostCount).toBe(0);
    await page.getByLabel("Optional public GitHub pull request URL").fill(publicPullRequestUrl);
    await page.getByRole("button", { name: "Add provider context" }).click();
    await expect(
      page
        .getByRole("navigation", { name: "Projects" })
        .getByRole("link", { name: /Ic3b3rg\/kestrel/u }),
    ).toBeVisible();
    await expect(page.getByText("Observed base", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Observed head", { exact: true })).toHaveCount(1);
    await expect(page.getByRole("status")).toContainText(
      "Project refreshed from the public GitHub pull request.",
    );
    expect(projectPostCount).toBe(1);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    const connectionPanel = page.locator(".github-connection");
    await expect(connectionPanel.getByRole("status")).toContainText("Checking");
    connectionProbeBlocked = false;
    releaseFirstConnectionProbe();
    await expect(connectionPanel.getByRole("status")).toContainText("Ready");
    await connectionPanel.getByLabel("Project access").selectOption(openedProject.project.id);
    await expect(connectionPanel).toContainText("Ic3b3rg/kestrel");
    await expect(connectionPanel).toContainText("operator");
    connectionActionRequired = true;
    await connectionPanel.getByRole("button", { name: "Verify again" }).click();
    await expect(connectionPanel.getByRole("status")).toContainText("Action required");
    await expect(connectionPanel).toContainText("gh auth login --hostname github.com");
    await expect(connectionPanel.getByText("Account", { exact: true })).toHaveCount(0);
    connectionActionRequired = false;
    await connectionPanel.getByRole("button", { name: "Verify again" }).click();
    await expect(connectionPanel.getByRole("status")).toContainText("Ready");
    expect(connectionProbeCount).toBeGreaterThanOrEqual(4);
    await expect(page.getByText("05 / OPERATOR", { exact: true })).toBeVisible();
    await expect(
      page.getByText(`Signed in as ${TEST_OPERATOR_CREDENTIALS.username}`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Operator security" })).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { level: 1, name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in to Kestrel" })).toHaveCount(0);
    const diagnosticButton = page.getByRole("button", { name: "Run diagnostic" });
    await expect(diagnosticButton).toBeEnabled();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to workspace" })).toBeFocused();
    await diagnosticButton.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Succeeded", { exact: true })).toBeVisible();

    const installationId = await page
      .getByRole("definition")
      .filter({ has: page.locator("code") })
      .first()
      .textContent();
    expect(installationId).not.toBeNull();

    await page.getByRole("button", { name: "Open Project", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Open an authorized repository" })).toBeVisible();
    const dialogAccessibility = await new AxeBuilder({ page })
      .include(".local-repository-dialog")
      .analyze();
    expect(dialogAccessibility.violations).toEqual([]);
    await context.setOffline(true);
    await expect(page.getByRole("dialog", { name: "Open an authorized repository" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("heading", { name: "Reconnect to view product data" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Run diagnostic" })).toBeDisabled();
    await expect(connectionPanel.getByRole("status")).toContainText("Unavailable");
    await expect(
      page.getByText(installationId ?? "missing Installation ID", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "openai/openai-node" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Ic3b3rg/kestrel" })).toHaveCount(0);

    await context.setOffline(false);
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await expect(
      page.getByText(installationId ?? "missing Installation ID", { exact: true }),
    ).toBeVisible();

    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
      true,
    );
    const animationDurationSeconds = await page
      .locator("body")
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).animationDuration));
    expect(animationDurationSeconds).toBeLessThanOrEqual(0.001);

    for (const width of [320, 768, 1_024, 1_440]) {
      await page.setViewportSize({ height: 900, width });
      await expect(
        page.getByRole("heading", { level: 1, name: "Settings", exact: true }),
      ).toBeVisible();
      const layout = await page.evaluate(() => {
        const viewportWidth = document.documentElement.clientWidth;
        const offenders = [...document.querySelectorAll("*")]
          .map((element) => ({
            className: element.className,
            right: element.getBoundingClientRect().right,
            tagName: element.tagName,
          }))
          .filter((element) => element.right > viewportWidth + 0.5)
          .slice(0, 10);
        return {
          offenders,
          scrollWidth: document.documentElement.scrollWidth,
          viewportWidth,
        };
      });
      expect(
        layout.scrollWidth,
        `horizontal overflow at ${String(width)}px: ${JSON.stringify(layout.offenders)}`,
      ).toBeLessThanOrEqual(layout.viewportWidth);
      const accessibility = await new AxeBuilder({ page }).analyze();
      expect(accessibility.violations, `axe violations at ${String(width)}px`).toEqual([]);
    }

    const updatedCredentials = {
      username: "operator-renamed",
      password: "a newly selected correct horse battery staple",
    };
    await page.getByLabel("Current password").fill(TEST_OPERATOR_CREDENTIALS.password);
    await page.getByLabel("Operator username").fill(updatedCredentials.username);
    await page.getByLabel("New password", { exact: true }).fill(updatedCredentials.password);
    await page.getByLabel("Confirm new password").fill(updatedCredentials.password);
    await page.getByRole("button", { name: "Change credentials and sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to Kestrel" })).toBeVisible();

    await page.getByLabel("Username").fill(updatedCredentials.username);
    await page.getByLabel("Password").fill(updatedCredentials.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(`Signed in as ${updatedCredentials.username}`, { exact: true }),
    ).toBeVisible();
    await runningStack.executeSql(`
      CREATE FUNCTION public.kestrel_test_reject_audit_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.event_type = 'operator.logout.succeeded' THEN
          RAISE EXCEPTION 'test rejects logout audit';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER kestrel_test_reject_audit_insert
      BEFORE INSERT ON installation_audit_records
      FOR EACH ROW
      EXECUTE FUNCTION public.kestrel_test_reject_audit_insert();
    `);
    expectedServiceUnavailableResponses = 1;
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sign in to Kestrel" })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText(
      "This browser is signed out. Operator logout audit is unavailable",
    );
    const remainingCookieNames = (await context.cookies()).map((cookie) => cookie.name);
    expect(remainingCookieNames).not.toContain("__Host-kestrel-session");
    expect(remainingCookieNames).not.toContain("__Host-kestrel-csrf");

    expect(expectedServiceUnavailableResponses).toBe(0);
    expect(browserErrors).toEqual([]);
  });
});
