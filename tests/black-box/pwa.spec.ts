import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

import {
  ExternalConceptualReviewPreparationSchema,
  FactoryConceptualReviewWorkflowReadSchema,
  HostGitHubProjectInboxSchema,
  ProjectInboxSchema,
  ReviewRevisionAvailableSchema,
  type ChangeIntentVersionCreated,
  type CodexReviewModelPreference,
  type CodexSubscriptionConnection,
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
  await page.getByRole("button", { name: "Pull requests", exact: true }).click();
  await page.getByText("Repository details", { exact: true }).click();
  const saved = page.locator(".saved-changes");
  if (await saved.count()) {
    await saved.locator("summary").click();
    await saved.getByRole("button").first().click();
  }
}

function blockedExternalReviewPreparation(projectId: string, changeProposalId: string) {
  return ExternalConceptualReviewPreparationSchema.parse({
    schemaVersion: 1,
    projectId,
    featureId: null,
    changeProposalId,
    preparationDigest: null,
    basis: null,
    publication: null,
    evidence: null,
    configuration: {
      model: { route: "codex_subscription", modelId: null },
      runtimePolicy: {
        kind: "retained_source_review",
        version: 1,
        adapter: "codex_app_server",
        adapterVersion: 1,
        containerImage: null,
        containerUser: null,
        codexExecutable: null,
        codexExecutableDigest: null,
        codexVersion: null,
        codexProtocol: "app_server_v2",
        sourceAccess: "retained_read_only",
        networkAccess: false,
        writeAccess: false,
        status: "unavailable",
      },
      resources: {
        maximumAttempts: 3,
        timeoutSeconds: 900,
        maximumEvidenceItems: 400,
        maximumWorkspaceFiles: 20000,
        maximumWorkspaceBytes: 268435456,
        maximumGraphNodes: 800,
        maximumOutputBytes: 131072,
        containerPidsLimit: 128,
        containerMemoryBytes: 1073741824,
        containerNanoCpus: 2000000000,
        containerTmpfsBytes: 67108864,
      },
    },
    readiness: {
      state: "blocked",
      startAllowed: false,
      blockers: [
        "publication_not_ready",
        "change_intent_not_available",
        "model_not_selected",
        "review_runtime_unavailable",
      ],
    },
  });
}

async function mockBlockedExternalReview(
  page: Page,
  projectId: string,
  changeProposalId: string,
): Promise<void> {
  const reviewRoot = `/api/v1/projects/${projectId}/change-proposals/${changeProposalId}/review`;
  await page.route(
    (url) => url.pathname.startsWith(reviewRoot),
    async (route: Route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === `${reviewRoot}/preparation`) {
        await route.fulfill({
          json: blockedExternalReviewPreparation(projectId, changeProposalId),
        });
        return;
      }
      if (pathname === `${reviewRoot}/workflows/current`) {
        await route.fulfill({ json: { schemaVersion: 1, review: null } });
        return;
      }
      if (pathname === `${reviewRoot}/artifacts`) {
        await route.fulfill({
          json: { schemaVersion: 1, reviews: [], offset: 0, total: 0, nextOffset: null },
        });
        return;
      }
      await route.fulfill({ status: 404 });
    },
  );
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
      WHERE source_identity IN ('${"e".repeat(64)}', '${"f".repeat(64)}');
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

      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await expect(page.getByLabel("Project to configure")).not.toHaveValue("");
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

  test("the Operator consults and selects the live host pull-request inbox", async ({ page }) => {
    if (stack === undefined) throw new Error("Host GitHub inbox browser stack is unavailable");
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

      WITH switch_project AS (
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
               'R_browser_project_switch',
               'example',
               'switch-repo',
               'https://github.com/example/switch-repo'
        FROM installations
        RETURNING id, installation_id
      )
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
             '${"f".repeat(64)}',
             '018f0f89-9a1e-7d64-a5dd-18cc3e317402',
             '018f0f89-9a1f-72ae-82c4-ef8ee27d6933',
             'switch-repo',
             'switch-repo',
             'sha1',
             'example',
             'switch-repo',
             'attached'
      FROM switch_project;
    `);
    const projectInbox = ProjectInboxSchema.parse(
      await (await runningStack.fetchApi("/api/v1/projects")).json(),
    );
    const project = projectInbox.projects.find(
      (candidate) => candidate.repository?.name === "openai-node",
    );
    const existingProposal = project?.changeProposals.find(
      (candidate) => candidate.kind === "provider_observed",
    );
    if (project === undefined || existingProposal?.kind !== "provider_observed") {
      throw new Error("Host GitHub inbox browser fixture is unavailable");
    }
    const switchProject = projectInbox.projects.find(
      (candidate) => candidate.repository?.name === "switch-repo",
    );
    if (switchProject === undefined) {
      throw new Error("Host GitHub Project-switch browser fixture is unavailable");
    }

    const availableInbox = HostGitHubProjectInboxSchema.parse({
      schemaVersion: 1,
      projectId: project.id,
      route: "host_gh",
      limitations: ["Host session, bounded reads, and manual refresh only."],
      status: {
        executableVersion: "2.87.0",
        availability: "available",
        host: "github.com",
        authentication: "authenticated",
        account: "operator",
      },
      groupStates: [
        { group: "review_requested", state: "available", failureReason: null },
        { group: "authored", state: "available", failureReason: null },
        { group: "other", state: "available", failureReason: null },
      ],
      pullRequests: [
        {
          number: 42,
          title: "Review the bounded provider read",
          body: "Keep host credentials outside Kestrel.",
          url: "https://github.com/openai/openai-node/pull/42",
          author: "reviewer",
          updatedAt: "2026-09-02T12:03:00.000Z",
          group: "review_requested",
        },
        {
          number: 43,
          title: "Keep the Project inbox scoped",
          body: "The Operator authored this change.",
          url: "https://github.com/openai/openai-node/pull/43",
          author: "operator",
          updatedAt: "2026-09-02T12:02:00.000Z",
          group: "authored",
        },
        {
          number: 44,
          title: "Document the local boundary",
          body: "",
          url: "https://github.com/openai/openai-node/pull/44",
          author: null,
          updatedAt: "2026-09-02T12:01:00.000Z",
          group: "other",
        },
      ],
      observedAt: "2026-09-02T12:04:00.000Z",
    });
    const partialInbox = HostGitHubProjectInboxSchema.parse({
      ...availableInbox,
      groupStates: [
        { group: "review_requested", state: "available", failureReason: null },
        { group: "authored", state: "unavailable", failureReason: "rate_limited" },
        { group: "other", state: "unavailable", failureReason: "rate_limited" },
      ],
      pullRequests: [availableInbox.pullRequests[0]],
      observedAt: "2026-09-02T12:05:00.000Z",
    });
    const switchInbox = HostGitHubProjectInboxSchema.parse({
      ...availableInbox,
      projectId: switchProject.id,
      pullRequests: [
        {
          number: 77,
          title: "Keep the switched Project isolated",
          body: "Only the selected Project owns this inbox result.",
          url: "https://github.com/example/switch-repo/pull/77",
          author: "switch-reviewer",
          updatedAt: "2026-09-02T12:03:30.000Z",
          group: "review_requested",
        },
      ],
    });
    const observedProposal = {
      ...existingProposal,
      author: { login: "reviewer", providerId: "U_host_42" },
      canonicalUrl: "https://github.com/openai/openai-node/pull/42",
      changeIntent: null,
      changeIntentCandidates: [
        {
          id: "provider_description",
          kind: "provider_field" as const,
          label: "GitHub description",
          text: "Long provider description.\n".repeat(80),
          version: "2026-09-02T12:06:00.000Z",
          provenance: {
            canonicalUrl: "https://github.com/openai/openai-node/pull/42",
            field: "description" as const,
            kind: "provider_field" as const,
            observedAt: "2026-09-02T12:06:00.000Z",
            provider: "github" as const,
          },
        },
      ],
      id: "018f0f89-9192-755f-aa96-f72094c734ab",
      number: 42,
      observedAt: "2026-09-02T12:06:00.000Z",
      providerId: "PR_host_42",
      reviewRevisions: [],
      title: "Review the bounded provider read",
      version: 1,
    };
    const observedProject = ProjectInboxSchema.parse({
      schemaVersion: 1,
      projects: [
        {
          ...project,
          changeProposals: [observedProposal, ...project.changeProposals],
          providerObservation: {
            account: "operator",
            authentication: "host_session",
            host: "github.com",
            kind: "host_gh",
            refresh: "manual",
          },
          updatedAt: "2026-09-02T12:06:00.000Z",
        },
      ],
    }).projects[0];
    if (observedProject === undefined) throw new Error("Observed Project fixture is unavailable");

    let releaseInitialRead: () => void = () => undefined;
    const initialReadGate = new Promise<void>((resolve) => {
      releaseInitialRead = resolve;
    });
    let markInitialRead: () => void = () => undefined;
    const initialRead = new Promise<void>((resolve) => {
      markInitialRead = resolve;
    });
    let inboxReadCount = 0;
    let refreshReadCount = 0;
    let refreshUrl: string | null = null;
    const inboxPath = `/api/v1/projects/${project.id}/provider/github`;
    await page.route(
      (url) => url.pathname === inboxPath,
      async (route: Route) => {
        const request = route.request();
        expect(request.method()).toBe("GET");
        inboxReadCount += 1;
        const refresh = new URL(request.url()).searchParams.get("refresh") === "true";
        if (refresh) {
          refreshReadCount += 1;
          refreshUrl = request.url();
          await route.fulfill({ json: partialInbox, status: 200 });
          return;
        }
        markInitialRead();
        await initialReadGate;
        await route.fulfill({ json: availableInbox, status: 200 });
      },
    );
    const switchInboxPath = `/api/v1/projects/${switchProject.id}/provider/github`;
    let switchInboxReadCount = 0;
    await page.route(
      (url) => url.pathname === switchInboxPath,
      async (route: Route) => {
        expect(route.request().method()).toBe("GET");
        switchInboxReadCount += 1;
        await route.fulfill({ json: switchInbox, status: 200 });
      },
    );

    let markSelectionObserved: () => void = () => undefined;
    const selectionObserved = new Promise<void>((resolve) => {
      markSelectionObserved = resolve;
    });
    const observePath = `${inboxPath}/pull-requests/observe`;
    await page.route(
      (url) => url.pathname === observePath,
      async (route: Route) => {
        const request = route.request();
        expect(request.method()).toBe("POST");
        const command: unknown = request.postDataJSON();
        expect(command).toEqual({ number: 42 });
        expect(Object.keys(command as Record<string, unknown>)).toEqual(["number"]);
        expect(request.headers()["x-kestrel-csrf"]).toBeTruthy();
        expect(request.headers().authorization).toBeUndefined();
        markSelectionObserved();
        await route.fulfill({ json: { schemaVersion: 1, project: observedProject }, status: 200 });
      },
    );
    let revisionRequestCount = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/v1/review-revisions")) {
        revisionRequestCount += 1;
      }
    });
    await mockBlockedExternalReview(page, project.id, observedProposal.id);

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
    await initialRead;

    const panel = page.getByRole("region", { name: "Pull request inbox" });
    await expect(panel).toContainText("Loading pull requests");
    releaseInitialRead();
    await expect(panel.locator("tbody tr")).toHaveCount(3);
    await expect(panel).toContainText("Review the bounded provider read");
    await panel.getByRole("tab", { name: /^Authored/u }).click();
    await expect(panel.locator("tbody tr")).toHaveCount(1);
    await expect(panel.locator("tbody")).toContainText("#43");
    await panel.getByRole("tab", { name: /^All/u }).click();
    await panel.getByRole("tab", { name: /^All/u }).hover();
    expect((await new AxeBuilder({ page }).include(".pr-filters").analyze()).violations).toEqual(
      [],
    );
    for (const width of [1440, 3440]) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await page.evaluate(() => {
        const rail = document.querySelector(".project-rail")?.getBoundingClientRect();
        const table = document.querySelector(".pr-table")?.getBoundingClientRect();
        if (rail === undefined || table === undefined)
          throw new Error("Workspace geometry is missing");
        return {
          rail: { height: rail.height, y: rail.y },
          table: { y: table.y, right: table.right },
          viewport: innerWidth,
        };
      });
      expect(geometry.rail.height).toBe(900);
      expect(geometry.rail.y).toBe(0);
      expect(geometry.table.y).toBeLessThan(300);
      expect(geometry.viewport - geometry.table.right).toBeLessThan(40);
      if (width === 1440) {
        await page.screenshot({ path: test.info().outputPath("factory-desktop.png") });
      }
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("factory-narrow.png"),
    });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 900 });
    await openProjectWorkspace(page, "example/switch-repo");
    await expect(panel).toContainText("#77");
    await expect(panel).toContainText("Keep the switched Project isolated");
    await expect(panel).not.toContainText("#42");
    expect(switchInboxReadCount).toBeGreaterThanOrEqual(1);
    await openProjectWorkspace(page);
    await expect(panel).toContainText("#42");
    await expect(panel).not.toContainText("#77");
    const automaticReadCount = inboxReadCount;
    expect(automaticReadCount).toBeGreaterThanOrEqual(1);
    await panel.getByRole("button", { name: "Refresh pull requests" }).click();
    await expect(
      panel.getByRole("alert").filter({ hasText: "Authored unavailable" }),
    ).toContainText("GitHub rate limit reached");
    await expect(panel.getByRole("alert").filter({ hasText: "Others unavailable" })).toContainText(
      "GitHub rate limit reached",
    );
    await expect(panel.locator("tbody")).toContainText("#42");
    expect(inboxReadCount).toBe(automaticReadCount + 1);
    expect(refreshReadCount).toBe(1);
    expect(refreshUrl).toContain("refresh=true");
    const inboxReadCountAfterRefresh = inboxReadCount;

    const select = panel.getByRole("button", { name: /^Select PR #42:/u });
    await select.focus();
    await page.keyboard.press("Enter");
    await selectionObserved;
    await expect(page.getByRole("status").filter({ hasText: "Project refreshed" })).toContainText(
      "Project refreshed through the host GitHub session.",
    );
    await expect(
      page.getByRole("link", { name: "#42 · Review the bounded provider read" }),
    ).toBeVisible();
    expect(inboxReadCount).toBe(inboxReadCountAfterRefresh);
    expect(revisionRequestCount).toBe(0);
    const purpose = page.getByRole("region", { name: "What this change is meant to do" });
    await expect(purpose).toContainText("Review the bounded provider read");
    await expect(purpose).toContainText("Pull request stated");
    await expect(purpose.getByText("Correct this explanation", { exact: true })).toBeVisible();
    await expect(purpose.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByText(/proposal version/iu)).toHaveCount(0);

    const accessibility = await new AxeBuilder({ page })
      .include(".host-github-panel")
      .include(".proposal-list")
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await page.setViewportSize({ height: 900, width: 320 });
    await expect(panel).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect(browserErrors).toEqual([]);
  });

  test("the Operator selects and retains a pull request at its current exact head", async ({
    page,
  }) => {
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
    if (
      project === undefined ||
      project.repository === null ||
      proposal?.kind !== "provider_observed"
    ) {
      throw new Error("Observed pull-request browser fixture is unavailable");
    }
    if (project.localRepositorySource === null) {
      throw new Error("Observed pull-request browser source is unavailable");
    }
    const selectedProject = {
      ...project,
      providerObservation: {
        account: "operator",
        authentication: "host_session" as const,
        host: "github.com",
        kind: "host_gh" as const,
        refresh: "manual" as const,
      },
    };
    const unselectedProject = { ...selectedProject, changeProposals: [] };
    const changeIntentText = proposal.title;
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
      changeOverview: {
        state: "ready" as const,
        createdAt: "2026-08-28T12:05:01.000Z",
        exactRevision: {
          id: reviewRevision.id,
          objectFormat: reviewRevision.objectFormat,
          base: {
            ...reviewRevision.base,
            author: "Base Author",
            subject: "Establish the source boundary",
          },
          head: {
            ...reviewRevision.head,
            author: "Head Author",
            subject: "Keep revision acquisition exact",
          },
        },
        changeIntent: acquisitionChangeIntent,
        modelRendering: { state: "not_generated" as const },
        providerObservation: {
          canonicalUrl: proposal.canonicalUrl,
          description: proposal.body ?? null,
          observedAt: proposal.observedAt,
          title: proposal.title,
        },
        sourceFacts: {
          ruleVersion: 1 as const,
          commitStatistics: { baseTreeFileCount: 3, headTreeFileCount: 4 },
          fileStatistics: { added: 0, modified: 1, deleted: 0, total: 1 },
          changedFiles: [
            {
              path: "src/revision.ts",
              status: "modified" as const,
              base: { mode: "100644" as const, objectId: "c".repeat(40), type: "blob" as const },
              head: { mode: "100644" as const, objectId: "d".repeat(40), type: "blob" as const },
            },
          ],
          pathAreas: [
            {
              pathPrefix: "src",
              changedFileCount: 1,
              samplePaths: ["src/revision.ts"],
            },
          ],
          warnings: [
            {
              code: "git_lfs_pointer_not_hydrated" as const,
              affectedFileCount: 1,
              samplePaths: ["src/revision.ts"],
            },
          ],
        },
      },
      reviewRevisions: [reviewRevision],
    };
    const availableProject = {
      ...selectedProject,
      changeProposals: selectedProject.changeProposals.map((candidate) =>
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
    const movedHeadObjectId = "f".repeat(40);
    const movedProject = ProjectInboxSchema.parse({
      schemaVersion: 1,
      projects: [
        {
          ...available.project,
          changeProposals: available.project.changeProposals.map((candidate) =>
            candidate.id === proposal.id
              ? {
                  ...candidate,
                  changeOverview: {
                    state: "awaiting_source" as const,
                    exactHeadObjectId: movedHeadObjectId,
                  },
                  head: { ...candidate.head, objectId: movedHeadObjectId },
                  observedAt: "2026-08-28T12:06:00.000Z",
                  version: candidate.version + 1,
                }
              : candidate,
          ),
          updatedAt: "2026-08-28T12:06:00.000Z",
        },
      ],
    }).projects[0];
    if (movedProject === undefined) {
      throw new Error("Moved observed pull-request browser fixture is unavailable");
    }

    let selected = false;
    let acquired = false;
    await page.route("**/api/v1/projects", async (route: Route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          json: {
            schemaVersion: 1,
            projects: [
              acquired ? available.project : selected ? selectedProject : unselectedProject,
            ],
          },
        });
        return;
      }
      await route.continue();
    });
    await page.route("**/api/v1/projects/*/provider/github", async (route: Route) => {
      await route.fulfill({
        json: HostGitHubProjectInboxSchema.parse({
          schemaVersion: 1,
          projectId: project.id,
          route: "host_gh",
          limitations: ["Host session, bounded reads, and manual refresh only."],
          status: {
            executableVersion: "2.87.0",
            availability: "available",
            host: "github.com",
            authentication: "authenticated",
            account: "operator",
          },
          groupStates: [
            { group: "review_requested", state: "available", failureReason: null },
            { group: "authored", state: "available", failureReason: null },
            { group: "other", state: "available", failureReason: null },
          ],
          pullRequests: [
            {
              author: "octocat",
              body: "",
              group: "review_requested",
              number: proposal.number,
              title: proposal.title,
              updatedAt: "2026-08-28T12:04:00.000Z",
              url: proposal.canonicalUrl,
            },
          ],
          observedAt: "2026-08-28T12:00:00.000Z",
        }),
        status: 200,
      });
    });
    let observationCount = 0;
    const observationPath = `/api/v1/projects/${project.id}/provider/github/pull-requests/observe`;
    await page.route(
      (url) => url.pathname === observationPath,
      async (route: Route) => {
        const request = route.request();
        expect(request.method()).toBe("POST");
        expect(request.postDataJSON()).toEqual({ number: proposal.number });
        expect(request.headers()["x-kestrel-csrf"]).toBeTruthy();
        expect(request.headers().authorization).toBeUndefined();
        observationCount += 1;
        if (observationCount === 1) selected = true;
        await route.fulfill({
          json: {
            schemaVersion: 1,
            project: observationCount === 1 ? selectedProject : movedProject,
          },
          status: 200,
        });
      },
    );
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
    await expect(page.getByText("Credentials stay with host Git", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: `#${String(proposal.number)} · ${proposal.title}` }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: `Select PR #${String(proposal.number)}` }).click();
    const proposalDetail = page.locator(".change-proposal").filter({ hasText: proposal.title });
    const projectFacts = page.locator(".project-facts");
    await expect(projectFacts.getByText("Local Repository Source", { exact: true })).toBeVisible();
    await expect(projectFacts.getByText("Provider Observation", { exact: true })).toBeVisible();
    await expect(proposalDetail).toBeVisible();
    await expect(proposalDetail).toContainText("Revision State");
    await expect(proposalDetail).toContainText("Not acquired");
    const purpose = page.getByRole("region", { name: "What this change is meant to do" });
    await expect(purpose).toContainText(changeIntentText);
    await expect(purpose).toContainText("Pull request stated");
    await expect(page.getByText(/host credential helper/u)).toBeVisible();
    await expect(page.getByText(/never receives or stores the credential/u)).toBeVisible();
    const acquire = page.getByRole("button", { name: "Retain source and confirm purpose" });
    await acquire.click();
    await requestObserved;
    await expect(page.getByRole("button", { name: "Retaining…" })).toBeDisabled();
    releaseResponse();
    await expect(page.locator(".activity-line")).toContainText(
      "The exact Review Revision is available.",
    );
    await expect(
      page.getByRole("button", { name: "Retain source and confirm purpose" }),
    ).toHaveCount(0);
    await expect(purpose).toContainText(changeIntentText);
    await expect(purpose).toContainText("Operator confirmed");
    await expect(page.getByText("Available", { exact: true })).toHaveCount(2);
    const overview = proposalDetail.getByRole("region", { name: "Change Overview" });
    await expect(overview).toContainText("Base snapshot · 3 files");
    await expect(overview).toContainText("Head snapshot · 4 files");
    await expect(overview).toContainText("1 changed file · 0 added · 1 modified · 0 deleted");
    await expect(overview).toContainText("src/revision.ts");
    await expect(overview).toContainText("Source area");
    await expect(overview).toContainText("Git LFS pointer content was not hydrated");
    await expect(
      overview.getByLabel(`Change Overview exact base object ID ${reviewRevision.base.objectId}`),
    ).toBeVisible();
    await expect(
      overview.getByLabel(`Change Overview exact head object ID ${reviewRevision.head.objectId}`),
    ).toBeVisible();
    await proposalDetail
      .getByRole("button", { name: `Refresh PR #${String(proposal.number)}` })
      .click();
    await expect(proposalDetail).toContainText("Not acquired");
    await expect(overview.locator(".change-overview-status")).toHaveText("Awaiting exact source");
    await expect(
      proposalDetail.getByRole("button", { name: `Retain exact PR #${String(proposal.number)}` }),
    ).toBeVisible();
    await expect(
      proposalDetail.getByLabel(`Observed head object ID ${movedHeadObjectId}`),
    ).toBeVisible();
    await expect(overview).not.toContainText("src/revision.ts");
    expect(observationCount).toBe(2);
    const accessibility = await new AxeBuilder({ page }).include(".projects-section").analyze();
    expect(accessibility.violations).toEqual([]);
    expect(browserErrors).toEqual([]);
  });

  test("the Operator starts and explores an independent review of an exact external PR", async ({
    page,
  }) => {
    if (stack === undefined) throw new Error("External review browser stack is unavailable");
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
    if (
      project === undefined ||
      project.repository === null ||
      proposal?.kind !== "provider_observed"
    ) {
      throw new Error("External review browser fixture is unavailable");
    }

    const at = "2026-09-20T00:00:00.000Z";
    const source = {
      id: "018f0f89-9a1d-7484-b224-866ef9d69990",
      repositoryId: "018f0f89-9a1e-7d64-a5dd-18cc3e317401",
      displayName: "openai-node",
      state: "attached" as const,
      objectFormat: "sha1" as const,
      createdAt: at,
      updatedAt: at,
    };
    const reviewRevision = {
      id: "018f0f89-9a21-7271-b92d-f1cb0d48bb47",
      state: "available" as const,
      objectFormat: "sha1" as const,
      base: proposal.base,
      head: proposal.head,
      objectCount: 7,
      retainedBytes: 4096,
      failureReason: null,
      createdAt: at,
      availableAt: at,
    };
    const changeIntent = {
      acceptanceOutcomes: ["Repository access remains explicit"],
      createdAt: at,
      id: "018f0f89-9a20-79f9-9990-dda80c9b917d",
      objective: "Keep repository access explicit",
      resolution: { state: "resolved" as const, issues: [] },
      scopeBoundaries: ["The exact pull request change"],
      sourceDigest: "a".repeat(64),
      sources: [
        {
          id: "operator_input",
          kind: "operator_input" as const,
          label: "Operator input",
          provenance: { kind: "operator_input" as const },
          text: "Keep repository access explicit",
          version: "1",
        },
      ],
      text: "Keep repository access explicit",
      version: 1,
    };
    const reviewProposal = {
      ...proposal,
      body: "Keep repository access explicit.",
      changeIntent,
      reviewRevisions: [reviewRevision],
    };
    const selectedProject = ProjectInboxSchema.parse({
      schemaVersion: 1,
      projects: [
        {
          ...project,
          localRepositorySource: source,
          sourceAvailability: "available",
          changeProposals: [reviewProposal],
        },
      ],
    }).projects[0];
    if (selectedProject === undefined) throw new Error("External review Project is unavailable");

    const preparationDigest = "d".repeat(64);
    const retainedManifestDigest = "c".repeat(64);
    const workflowId = "018f0f89-a45f-79af-8544-650e9f15c211";
    const artifactId = "018f0f89-a45f-79af-8544-650e9f15c212";
    const requestId = "65cc9964-10c2-49d1-86c4-8f13f5019e86";
    const preparation = ExternalConceptualReviewPreparationSchema.parse({
      schemaVersion: 1,
      projectId: project.id,
      featureId: null,
      changeProposalId: proposal.id,
      preparationDigest,
      basis: {
        objective: changeIntent.objective,
        scope: { includes: changeIntent.scopeBoundaries, excludes: [] },
        outcomes: [
          {
            key: "stated_intent",
            outcome: changeIntent.acceptanceOutcomes[0],
            intent: { kind: "operator_confirmed", label: "Operator input" },
          },
        ],
        provenance: {
          kind: "change_intent",
          changeIntentId: changeIntent.id,
          version: changeIntent.version,
          sourceDigest: changeIntent.sourceDigest,
          resolution: "resolved",
          sources: [{ kind: "operator_confirmed", label: "Operator input" }],
        },
        limitations: ["No executed test results are linked to this external pull request."],
      },
      publication: {
        kind: "external_pull_request",
        pullRequest: {
          repository: {
            id: project.repository.providerId,
            owner: project.repository.owner,
            name: project.repository.name,
          },
          author: proposal.author?.login ?? null,
          number: proposal.number,
          url: proposal.canonicalUrl,
          state: proposal.proposalState,
          title: proposal.title,
          body: reviewProposal.body,
          baseRef: proposal.base.ref,
          headRef: proposal.head.ref,
          baseCommitId: proposal.base.objectId,
          headCommitId: proposal.head.objectId,
        },
        revision: reviewRevision,
        retainedManifestDigest,
        certificate: null,
      },
      evidence: {
        source: {
          baseCommitId: proposal.base.objectId,
          headCommitId: proposal.head.objectId,
          headTreeId: "c".repeat(40),
          retainedManifestDigest,
          limits: {
            catalogPageEntries: 200,
            fileBytes: 524288,
            lineRange: 200,
            responseBytes: 32768,
          },
        },
        checks: null,
      },
      configuration: {
        model: { route: "codex_subscription", modelId: "gpt-6-astra" },
        runtimePolicy: {
          kind: "retained_source_review",
          version: 1,
          adapter: "codex_app_server",
          adapterVersion: 1,
          containerImage: `sha256:${"1".repeat(64)}`,
          containerUser: "501:20",
          codexExecutable: "/usr/local/bin/codex",
          codexExecutableDigest: "e".repeat(64),
          codexVersion: "0.155.1",
          codexProtocol: "app_server_v2",
          sourceAccess: "retained_read_only",
          networkAccess: false,
          writeAccess: false,
          status: "available",
        },
        resources: {
          maximumAttempts: 3,
          timeoutSeconds: 900,
          maximumEvidenceItems: 400,
          maximumWorkspaceFiles: 20000,
          maximumWorkspaceBytes: 268435456,
          maximumGraphNodes: 800,
          maximumOutputBytes: 131072,
          containerPidsLimit: 128,
          containerMemoryBytes: 1073741824,
          containerNanoCpus: 2000000000,
          containerTmpfsBytes: 67108864,
        },
      },
      readiness: { state: "ready", startAllowed: true, blockers: [] },
    });
    const queued = FactoryConceptualReviewWorkflowReadSchema.parse({
      schemaVersion: 1,
      workflow: {
        id: workflowId,
        requestId,
        projectId: project.id,
        featureId: null,
        changeProposalId: proposal.id,
        inputDigest: preparationDigest,
        reviewRevisionId: reviewRevision.id,
        state: "queued",
        attempt: { current: 0, maximum: 3 },
        failure: null,
        artifactId: null,
        requestedAt: at,
        startedAt: null,
        finishedAt: null,
      },
      artifact: null,
      currency: "up_to_date",
    });
    const published = FactoryConceptualReviewWorkflowReadSchema.parse({
      schemaVersion: 1,
      workflow: {
        ...queued.workflow,
        state: "published",
        attempt: { current: 1, maximum: 3 },
        artifactId,
        startedAt: at,
        finishedAt: at,
      },
      artifact: {
        schemaVersion: 1,
        id: artifactId,
        workflowId,
        inputDigest: preparationDigest,
        reviewRevisionId: reviewRevision.id,
        baseCommitId: proposal.base.objectId,
        headCommitId: proposal.head.objectId,
        status: "partial",
        evidenceScope: {
          source: "exact_retained_revision",
          executedChecks: "not_linked",
          narrativeAuthority: "source_only_model_interpretation",
        },
        graph: {
          result: "partial",
          summary: "The pull request keeps repository access explicit.",
          outcomes: [
            {
              id: "outcome-access",
              outcomeKey: "stated_intent",
              title: "Repository access remains explicit",
              coverage: "mapped",
              behavioralStepIds: ["behavior-access"],
              reason: "The retained implementation requires an explicit source.",
            },
          ],
          behavioralSteps: [
            {
              id: "behavior-access",
              title: "Require an explicit repository source",
              description: "The handler rejects work without an authorized source binding.",
              change: "modified",
              outcomeKeys: ["stated_intent"],
              evidenceIds: ["source-access"],
            },
          ],
          evidence: [
            {
              id: "source-access",
              type: "source",
              side: "head",
              path: "src/review.ts",
              startLine: 10,
              endLine: 12,
              description: "Explicit source binding",
              sufficiency: "These retained lines show the authorization branch.",
              limitations: [],
            },
          ],
          problems: [],
          edges: [
            { from: "outcome-access", to: "behavior-access", kind: "implemented_by" },
            { from: "behavior-access", to: "source-access", kind: "supported_by" },
          ],
          limitations: ["No executed test results are linked to this external pull request."],
        },
        createdAt: at,
      },
      currency: "up_to_date",
    });

    await page.route("**/api/v1/projects", (route) =>
      route.fulfill({ json: { schemaVersion: 1, projects: [selectedProject] } }),
    );
    await page.route("**/api/v1/projects/*/provider/github", (route) =>
      route.fulfill({
        json: HostGitHubProjectInboxSchema.parse({
          schemaVersion: 1,
          projectId: project.id,
          route: "host_gh",
          limitations: ["Host session, bounded reads, and manual refresh only."],
          status: {
            executableVersion: "2.87.0",
            availability: "available",
            host: "github.com",
            authentication: "authenticated",
            account: "operator",
          },
          groupStates: ["review_requested", "authored", "other"].map((group) => ({
            group,
            state: "available",
            failureReason: null,
          })),
          pullRequests: [],
          observedAt: at,
        }),
      }),
    );

    let started = false;
    let workflowReads = 0;
    const reviewRoot = `/api/v1/projects/${project.id}/change-proposals/${proposal.id}/review`;
    await page.route(
      (url) => url.pathname.startsWith(reviewRoot),
      async (route: Route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (pathname === `${reviewRoot}/preparation`) {
          await route.fulfill({ json: preparation });
          return;
        }
        if (pathname === `${reviewRoot}/workflows/current`) {
          await route.fulfill({
            json: { schemaVersion: 1, review: started ? published : null },
          });
          return;
        }
        if (pathname === `${reviewRoot}/workflows` && request.method() === "POST") {
          expect(request.postDataJSON()).toEqual({ requestId, preparationDigest });
          expect(request.headers()["x-kestrel-csrf"]).toBeTruthy();
          started = true;
          await route.fulfill({ json: queued, status: 202 });
          return;
        }
        if (pathname === `${reviewRoot}/workflows/${workflowId}`) {
          workflowReads += 1;
          await route.fulfill({ json: published });
          return;
        }
        if (pathname === `${reviewRoot}/artifacts`) {
          await route.fulfill({
            json: {
              schemaVersion: 1,
              reviews: started
                ? [
                    {
                      artifactId,
                      workflowId,
                      status: "partial",
                      headCommitId: proposal.head.objectId,
                      requestedAt: at,
                      finishedAt: at,
                      currency: "up_to_date",
                    },
                  ]
                : [],
              offset: 0,
              total: started ? 1 : 0,
              nextOffset: null,
            },
          });
          return;
        }
        if (pathname === `${reviewRoot}/artifacts/${artifactId}/source/lines`) {
          const url = new URL(request.url());
          expect(Object.fromEntries(url.searchParams)).toEqual({
            side: "head",
            path: "src/review.ts",
            startLine: "10",
            endLine: "12",
          });
          await route.fulfill({
            json: {
              status: "available",
              side: "head",
              commitId: proposal.head.objectId,
              mode: "100644",
              objectId: "c".repeat(40),
              path: "src/review.ts",
              type: "blob",
              startLine: 10,
              endLine: 12,
              totalLines: 40,
              hasFinalNewline: true,
              lineEndings: ["lf", "lf", "lf"],
              text: "if (!source) return denied;\nreturn review(source);\n}",
            },
          });
          return;
        }
        await route.fulfill({ status: 404 });
      },
    );

    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        const value = message.text();
        if (
          value !==
          "Failed to load resource: the server responded with a status of 401 (Unauthorized)"
        ) {
          browserErrors.push(value);
        }
      }
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));

    await page.addInitScript((stableRequestId) => {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        configurable: true,
        value: () => stableRequestId,
      });
    }, requestId);
    await page.goto(runningStack.pwaUrl);
    await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
    await page.getByLabel("Password").fill(TEST_OPERATOR_CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await openProjectWorkspace(page);

    const purpose = page.getByRole("region", { name: "What this change is meant to do" });
    await expect(purpose).toContainText("Operator confirmed");
    const review = page.getByRole("region", {
      name: "Did this pull request deliver what it says?",
    });
    await expect(review).toContainText("Retained source is read only");
    await expect(review).toContainText("No executed test results are linked");
    await expect(review.getByRole("button", { name: "Start independent review" })).toBeEnabled();

    await review.getByRole("button", { name: "Start independent review" }).click();
    await expect(page.getByRole("heading", { name: "Review queued" })).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "The pull request keeps repository access explicit.",
      }),
    ).toBeVisible({ timeout: 5_000 });
    expect(workflowReads).toBeGreaterThanOrEqual(1);

    const graph = page.getByRole("region", { name: "Requirements review graph" });
    await expect(graph).toContainText("Requested outcomes");
    await expect(graph).toContainText("Behavioral Steps");
    await expect(graph).toContainText("Source evidence");
    await expect(graph).toContainText("Problems");
    await graph.getByRole("button", { name: /Explicit source binding/u }).click();
    await expect(page.getByText("if (!source) return denied;", { exact: false })).toBeVisible();
    await expect(page.getByText(/No executed test results are linked/iu).first()).toBeVisible();
    await expect(page.getByText(/Partial means/iu)).toBeVisible();

    await page.reload();
    await expect(
      page.getByRole("heading", {
        name: "The pull request keeps repository access explicit.",
      }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Review history" })).toContainText("partial");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(review).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).include(".change-proposal").analyze()).violations,
    ).toEqual([]);
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
    const initialIntent = {
      createdAt: "2026-08-28T12:03:00.000Z",
      id: "018f0f89-9a23-7d63-b6f7-108b7b4bf52f",
      objective: proposal.title,
      resolution: {
        state: "unresolved" as const,
        issues: [
          { kind: "missing" as const, field: "scope_boundaries" as const },
          { kind: "missing" as const, field: "acceptance_outcomes" as const },
        ],
      },
      scopeBoundaries: [],
      acceptanceOutcomes: [],
      sourceDigest: "e".repeat(64),
      sources: [source],
      text: proposal.title,
      version: 1,
    };
    const initialProject = {
      ...project,
      changeProposals: project.changeProposals.map((candidate) =>
        candidate.id === proposal.id ? { ...candidate, changeIntent: initialIntent } : candidate,
      ),
    };
    const objective = "Keep repository access explicit and read-only";
    const command = {
      acceptanceOutcomes: ["The selected source remains attributable"],
      expectedProposalVersion: proposal.version,
      objective,
      operatorInput: `Operator confirmation: ${objective}`,
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
      ...initialProject,
      changeProposals: initialProject.changeProposals.map((candidate) =>
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
    let preparationReads = 0;
    const reviewPreparationPath = `/api/v1/projects/${project.id}/change-proposals/${proposal.id}/review/preparation`;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === reviewPreparationPath) preparationReads += 1;
    });
    await page.route("**/api/v1/projects", (route) =>
      route.fulfill({
        json: { schemaVersion: 1, projects: [saved ? updatedProject : initialProject] },
      }),
    );
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
    const purpose = page.getByRole("region", { name: "What this change is meant to do" });
    await expect(purpose).toContainText("Pull request stated");
    await expect(purpose).toContainText(proposal.title);
    await expect(purpose.getByRole("checkbox")).toHaveCount(0);
    await purpose.getByText("Correct this explanation", { exact: true }).click();
    await purpose.getByLabel("Purpose", { exact: true }).fill(objective);
    await purpose.getByLabel(/In scope/u).fill("Do not add provider write authority");
    await page.getByLabel(/Expected results/u).fill("The selected source remains attributable");
    await purpose.getByRole("button", { name: "Save confirmed purpose" }).click();

    await expect(page.getByRole("status")).toContainText("Review purpose saved and confirmed.");
    await expect(purpose).toContainText("Operator confirmed");
    await expect(purpose).toContainText(objective);
    await expect(purpose).toContainText("Do not add provider write authority");
    await expect(purpose).toContainText("The selected source remains attributable");
    await expect.poll(() => preparationReads).toBeGreaterThanOrEqual(2);
    await expect(page.getByText(/Source digest/iu)).toHaveCount(0);
    await expect(page.getByText("Work Item", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Planning Session", { exact: true })).toHaveCount(0);
    const accessibility = await new AxeBuilder({ page }).include(".change-proposal").analyze();
    expect(accessibility.violations).toEqual([]);
    expect(browserErrors).toEqual([]);
  });

  test("the Operator runs and observes a diagnostic", async ({ context, page }) => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    const browserErrors: string[] = [];
    let expectedUnauthorizedResponses = 2;
    let expectedForbiddenResponses = 0;
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
          expectedForbiddenResponses > 0 &&
          text === "Failed to load resource: the server responded with a status of 403 (Forbidden)"
        ) {
          expectedForbiddenResponses -= 1;
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
    let loginRequestCount = 0;
    let releaseFirstLogin: () => void = () => undefined;
    const firstLoginGate = new Promise<void>((resolve) => {
      releaseFirstLogin = resolve;
    });
    await page.route("**/auth/login", async (route) => {
      loginRequestCount += 1;
      if (loginRequestCount === 1) await firstLoginGate;
      await route.continue();
    });
    let logoutRequestCount = 0;
    let releaseFirstLogout: () => void = () => undefined;
    const firstLogoutGate = new Promise<void>((resolve) => {
      releaseFirstLogout = resolve;
    });
    await page.route("**/auth/logout", async (route) => {
      logoutRequestCount += 1;
      if (logoutRequestCount === 1) await firstLogoutGate;
      await route.continue();
    });
    let stepUpRequestCount = 0;
    let releaseSuccessfulStepUp: () => void = () => undefined;
    const successfulStepUpGate = new Promise<void>((resolve) => {
      releaseSuccessfulStepUp = resolve;
    });
    await page.route("**/auth/step-up", async (route) => {
      stepUpRequestCount += 1;
      if (stepUpRequestCount === 2) await successfulStepUpGate;
      await route.continue();
    });
    let projectPostCount = 0;
    // This Project exists only in the provider-response fixture below.
    await page.route(`**/api/v1/projects/${openedProject.project.id}/features`, async (route) => {
      expect(route.request().method()).toBe("GET");
      await route.fulfill({ json: { schemaVersion: 1, features: [] }, status: 200 });
    });
    await page.route(
      `**/api/v1/projects/${openedProject.project.id}/model-profiles/direct-api`,
      async (route) => {
        await route.fulfill({ json: { profile: null, schemaVersion: 1 }, status: 200 });
      },
    );
    await page.route("**/api/v1/projects", async (route) => {
      const request = route.request();
      if (request.method() !== "POST") {
        const response = await route.fetch();
        const inbox = ProjectInboxSchema.parse(await response.json());
        await route.fulfill({
          response,
          json: { ...inbox, projects: [...inbox.projects, openedProject.project] },
        });
        return;
      }
      projectPostCount += 1;
      expect(request.postDataJSON()).toEqual({ url: publicPullRequestUrl });
      expect(request.headers()["x-kestrel-csrf"]).toBeTruthy();
      expect(request.headers().authorization).toBeUndefined();
      await route.fulfill({ json: openedProject, status: 200 });
    });
    const openedProposal = openedProject.project.changeProposals[0];
    if (openedProposal?.kind !== "provider_observed") {
      throw new Error("Opened pull-request fixture is unavailable");
    }
    await mockBlockedExternalReview(page, openedProject.project.id, openedProposal.id);

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

    let codexProbeCount = 0;
    let codexAuthenticationRequired = false;
    let codexModels = [
      { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", isDefault: true },
      { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", isDefault: false },
    ];
    let codexProbeBlocked = true;
    let releaseFirstCodexProbe: () => void = () => undefined;
    const firstCodexProbeGate = new Promise<void>((resolve) => {
      releaseFirstCodexProbe = resolve;
    });
    await page.route("**/api/v1/connections/codex", async (route) => {
      codexProbeCount += 1;
      if (codexProbeBlocked) await firstCodexProbeGate;
      const connection: CodexSubscriptionConnection = codexAuthenticationRequired
        ? {
            schemaVersion: 1,
            state: "action_required",
            reason: "authentication_required",
            cli: { version: "0.152.1", supported: true, protocol: "app_server_v2" },
            account: null,
            models: [],
            usage: null,
            checkedAt: "2026-09-02T20:01:00.000Z",
          }
        : codexModels.length === 0
          ? {
              schemaVersion: 1,
              state: "action_required",
              reason: "model_catalog_empty",
              cli: { version: "0.152.1", supported: true, protocol: "app_server_v2" },
              account: {
                authentication: "chatgpt",
                email: "operator@example.com",
                plan: "plus",
              },
              models: [],
              usage: {
                availability: "available",
                primary: {
                  usedPercent: 25,
                  windowDurationMinutes: 300,
                  resetsAt: "2026-09-02T22:00:00.000Z",
                },
                secondary: null,
              },
              checkedAt: "2026-09-02T20:00:00.000Z",
            }
          : {
              schemaVersion: 1,
              state: "ready",
              reason: null,
              cli: { version: "0.152.1", supported: true, protocol: "app_server_v2" },
              account: {
                authentication: "chatgpt",
                email: "operator@example.com",
                plan: "plus",
              },
              models: codexModels,
              usage: {
                availability: "available",
                primary: {
                  usedPercent: 25,
                  windowDurationMinutes: 300,
                  resetsAt: "2026-09-02T22:00:00.000Z",
                },
                secondary: null,
              },
              checkedAt: "2026-09-02T20:00:00.000Z",
            };
      await route.fulfill({ json: connection, status: 200 });
    });

    let reviewModelPreference: CodexReviewModelPreference = {
      schemaVersion: 1,
      route: "codex_subscription",
      selectedModelId: null,
      updatedAt: null,
    };
    await page.route("**/api/v1/settings/review-model", async (route) => {
      if (route.request().method() === "PUT") {
        const command = route.request().postDataJSON() as { modelId: string };
        reviewModelPreference = {
          schemaVersion: 1,
          route: "codex_subscription",
          selectedModelId: command.modelId,
          updatedAt: "2026-09-07T12:01:00.000Z",
        };
      }
      await route.fulfill({ json: reviewModelPreference, status: 200 });
    });

    await page.goto(runningStack.pwaUrl);
    await expect(page.getByRole("heading", { name: "Sign in to Kestrel" })).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to sign in" })).toBeFocused();
    await page.setViewportSize({ height: 800, width: 320 });
    const loginAccessibility = await new AxeBuilder({ page }).analyze();
    expect(loginAccessibility.violations).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ height: 800, width: 1_024 });
    const usernameInput = page.getByLabel("Username");
    const signIn = page.getByRole("button", { name: "Sign in" });
    await context.setOffline(true);
    await expect(page.getByRole("heading", { name: "Sign in to Kestrel" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Checking Operator session" })).toHaveCount(0);
    await expect(signIn).toBeDisabled();
    await expect(page.getByText("Reconnect before signing in.", { exact: true })).toBeVisible();
    expectedUnauthorizedResponses += 1;
    await context.setOffline(false);
    await expect(signIn).toBeEnabled();
    await usernameInput.focus();
    await page.keyboard.press("Enter");
    await expect(usernameInput).toBeFocused();
    await usernameInput.pressSequentially("operator");
    await expect(usernameInput).toBeFocused();
    await expect(usernameInput).toHaveValue("operator");
    await usernameInput.fill("operator name");
    const passwordInput = page.getByLabel("Password");
    await expect(passwordInput).toHaveValue("");
    await passwordInput.fill("not sent");
    await passwordInput.press("Enter");
    const usernameError = page.locator("#username-error");
    await expect(usernameError).toContainText("Start with a letter or number");
    await expect(usernameInput).toHaveAttribute("aria-describedby", "username-error");
    await expect(usernameInput).toBeFocused();
    await expect(usernameInput).toHaveValue("operator name");
    await expect(passwordInput).toHaveValue("");
    expect(loginRequestCount).toBe(0);
    await usernameInput.fill(TEST_OPERATOR_CREDENTIALS.username);
    await passwordInput.fill("not the Operator password");
    await passwordInput.press("Enter");
    await expect.poll(() => loginRequestCount).toBe(1);
    const signingIn = page.getByRole("button", { name: "Signing in…" });
    await expect(signingIn).toBeDisabled();
    await expect(page.getByRole("status", { name: "" })).toContainText("Signing in");
    releaseFirstLogin();
    const loginError = page.getByRole("alert");
    await expect(loginError).toContainText("The Operator credentials are invalid");
    await expect(loginError).toBeFocused();
    await expect(usernameInput).toHaveValue(TEST_OPERATOR_CREDENTIALS.username);
    await expect(passwordInput).toHaveValue("");
    await passwordInput.fill(TEST_OPERATOR_CREDENTIALS.password);
    await passwordInput.press("Enter");
    await expect(
      page.getByRole("heading", { level: 1, name: "Projects", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Operator authenticated. Reading the Kestrel Installation.", { exact: true }),
    ).toHaveCount(0);
    expectedUnauthorizedResponses = 0;
    const accountFooter = page.locator('[data-sidebar="footer"]');
    await expect(accountFooter.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await expect(
      accountFooter.getByRole("button", { name: "Sign out", exact: true }),
    ).toBeVisible();
    await expect(accountFooter).not.toContainText("Signed in as");
    await expect(accountFooter).not.toContainText(TEST_OPERATOR_CREDENTIALS.username);
    await expect(accountFooter).not.toContainText("Connected");

    await page.setViewportSize({ height: 800, width: 320 });
    await page.getByRole("button", { name: "Open navigation" }).click();
    const mobileFooter = page.locator('[data-mobile="true"] [data-sidebar="footer"]');
    await expect(mobileFooter.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await expect(mobileFooter.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await expect(mobileFooter).not.toContainText("Signed in as");
    await expect(mobileFooter).not.toContainText("Connected");
    await page.getByRole("button", { name: "Close navigation" }).click();
    await page.setViewportSize({ height: 800, width: 1_024 });

    const signOut = accountFooter.getByRole("button", { name: "Sign out", exact: true });
    await signOut.focus();
    await signOut.press("Enter");
    await page.keyboard.press("Enter");
    await expect.poll(() => logoutRequestCount).toBe(1);
    await expect(accountFooter.getByRole("button", { name: "Signing out…" })).toBeDisabled();
    await expect(accountFooter.getByRole("status")).toContainText("Signing out");
    releaseFirstLogout();
    await expect(page.getByRole("heading", { name: "Sign in to Kestrel" })).toBeVisible();
    await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
    await page.getByLabel("Password").fill(TEST_OPERATOR_CREDENTIALS.password);
    await page.getByLabel("Password").press("Enter");
    await expect(
      page.getByRole("heading", { level: 1, name: "Projects", exact: true }),
    ).toBeVisible();

    await openProjectWorkspace(page);
    await expect(page.getByText("Not acquired", { exact: true })).toHaveCount(2);
    await expect(page.getByText("Public GitHub pull request", { exact: true })).toBeVisible();
    await expect(page.getByText(/Refresh is Manual only/u)).toBeVisible();
    await expect(page.getByText("Not configured", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh PR #1234" })).toBeVisible();
    await page.getByText("Project menu", { exact: true }).click();
    await page
      .getByLabel("Public GitHub pull request URL")
      .fill("https://github.com/openai/openai-node");
    await page.getByRole("button", { name: "Open PR by URL" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Enter a canonical public pull request URL",
    );
    expect(projectPostCount).toBe(0);
    await page.getByLabel("Public GitHub pull request URL").fill(publicPullRequestUrl);
    await page.getByRole("button", { name: "Open PR by URL" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "This URL belongs to a different repository",
    );
    expect(projectPostCount).toBe(0);
    await openProjectWorkspace(page, "Ic3b3rg/kestrel");
    await page.getByText("Project menu", { exact: true }).click();
    await page.getByLabel("Public GitHub pull request URL").fill(publicPullRequestUrl);
    await page.getByRole("button", { name: "Open PR by URL" }).click();
    await expect(
      page
        .getByRole("navigation", { name: "Projects" })
        .getByRole("link", { name: /Ic3b3rg\/kestrel/u }),
    ).toBeVisible();
    await expect(page.getByText("Observed base", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Observed head", { exact: true })).toHaveCount(1);
    await expect(page.getByRole("status").filter({ hasText: "Project refreshed" })).toContainText(
      "Project refreshed from the public GitHub pull request.",
    );
    expect(projectPostCount).toBe(1);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    const connectionPanel = page.locator(".github-connection");
    const codexPanel = page.locator(".codex-connection");
    const reviewModelPanel = page.locator(".review-model-settings");
    await expect(connectionPanel.getByRole("status")).toContainText("Checking");
    await expect(codexPanel.getByRole("status")).toContainText("Checking");
    await expect(reviewModelPanel.locator(".state-marker")).toContainText("Checking");
    connectionProbeBlocked = false;
    releaseFirstConnectionProbe();
    codexProbeBlocked = false;
    releaseFirstCodexProbe();
    await expect(connectionPanel.getByRole("status")).toContainText("Ready");
    await expect(codexPanel.getByRole("status")).toContainText("Ready");
    await expect(codexPanel).toContainText("operator@example.com");
    await expect(codexPanel).toContainText("Plus");
    await expect(codexPanel).toContainText("GPT-5.6 Sol");
    await expect(codexPanel).toContainText("25% used");
    await expect(reviewModelPanel.locator(".state-marker")).toContainText("Choose a model");
    await reviewModelPanel.getByLabel("Default for future reviews").selectOption("gpt-5.6-sol");
    await reviewModelPanel.getByRole("button", { name: "Save default" }).click();
    await expect(reviewModelPanel.locator(".state-marker")).toContainText("Ready");
    await expect(reviewModelPanel).toContainText("Default saved for future review preparation");

    codexModels = [{ id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", isDefault: true }];
    await reviewModelPanel.getByRole("button", { name: "Refresh catalog" }).click();
    await expect(reviewModelPanel.locator(".state-marker")).toContainText("Action required");
    await expect(reviewModelPanel).toContainText("gpt-5.6-sol");
    await expect(reviewModelPanel).toContainText("did not select a fallback");
    await expect(reviewModelPanel.getByLabel("Default for future reviews")).toHaveValue("");

    codexModels = [];
    await reviewModelPanel.getByRole("button", { name: "Refresh catalog" }).click();
    await expect(reviewModelPanel.locator(".state-marker")).toContainText("Action required");
    await expect(reviewModelPanel).toContainText("No picker-visible models");
    await expect(reviewModelPanel.getByLabel("Default for future reviews")).toBeDisabled();

    codexModels = [{ id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", isDefault: true }];
    await reviewModelPanel.getByRole("button", { name: "Refresh catalog" }).click();
    await expect(reviewModelPanel.getByLabel("Default for future reviews")).toBeEnabled();
    await reviewModelPanel.getByLabel("Default for future reviews").selectOption("gpt-5.6-terra");
    await reviewModelPanel.getByRole("button", { name: "Save default" }).click();
    await expect(reviewModelPanel.locator(".state-marker")).toContainText("Ready");
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
    codexAuthenticationRequired = true;
    await codexPanel.getByRole("button", { name: "Verify again" }).click();
    await expect(codexPanel.getByRole("status")).toContainText("Action required");
    await expect(codexPanel).toContainText("codex login");
    await expect(codexPanel).not.toContainText("operator@example.com");
    await expect(reviewModelPanel.locator(".state-marker")).toContainText("Action required");
    await expect(reviewModelPanel).toContainText("Codex authentication is required");
    codexAuthenticationRequired = false;
    await codexPanel.getByRole("button", { name: "Verify again" }).click();
    await expect(codexPanel.getByRole("status")).toContainText("Ready");
    expect(codexProbeCount).toBeGreaterThanOrEqual(3);

    await expect(page.locator('[data-sidebar="footer"]')).not.toContainText("Signed in as");
    await expect(page.locator('[data-sidebar="footer"]')).not.toContainText("Connected");
    await expect(page.getByRole("heading", { name: "Operator security" })).toBeVisible();
    await expect(
      page.locator(".operator-security").getByRole("button", { name: "Sign out", exact: true }),
    ).toHaveCount(0);
    const reviewModelSelector = page.getByLabel("Default for future reviews");
    await reviewModelSelector.focus();
    await expect(reviewModelSelector).toBeFocused();
    await page.keyboard.press("Home");
    await page.keyboard.press("End");
    await expect(reviewModelSelector).toHaveValue("gpt-5.6-terra");
    await page.reload();
    await expect(
      page.getByRole("heading", { level: 1, name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in to Kestrel" })).toHaveCount(0);
    await expect(page.getByLabel("Default for future reviews")).toHaveValue("gpt-5.6-terra");
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
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Change credentials and sign out" }),
    ).toBeDisabled();
    await expect(connectionPanel.getByRole("status")).toContainText("Unavailable");
    await expect(codexPanel.getByRole("status")).toContainText("Unavailable");
    await expect(
      page.getByText(installationId ?? "missing Installation ID", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: /openai\/openai-node/u })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Ic3b3rg\/kestrel/u })).toHaveCount(0);

    await context.setOffline(false);
    await expect(
      page.getByText(installationId ?? "missing Installation ID", { exact: true }),
    ).toBeVisible();
    await expect(page.locator('[data-sidebar="footer"]')).not.toContainText("Connected");

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
      await expect(page.getByLabel("Default for future reviews")).toBeVisible();
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
    const currentPassword = page.getByLabel("Current password");
    const operatorUsername = page.getByLabel("Operator username");
    const newPassword = page.getByLabel("New password", { exact: true });
    const passwordConfirmation = page.getByLabel("Confirm new password");
    await currentPassword.focus();
    await page.keyboard.press("Enter");
    await expect(currentPassword).toBeFocused();
    await currentPassword.pressSequentially("current password");
    await expect(currentPassword).toBeFocused();
    await expect(currentPassword).toHaveValue("current password");
    await expect(newPassword).toHaveValue("");
    await currentPassword.fill(TEST_OPERATOR_CREDENTIALS.password);
    await operatorUsername.fill(updatedCredentials.username);
    await newPassword.fill(updatedCredentials.password);
    await passwordConfirmation.fill("a different new password");
    await passwordConfirmation.press("Enter");
    const confirmationError = page.locator("#operator-new-password-confirmation-error");
    await expect(confirmationError).toContainText("does not match");
    await expect(passwordConfirmation).toHaveAttribute(
      "aria-describedby",
      "operator-new-password-confirmation-error",
    );
    await expect(passwordConfirmation).toBeFocused();
    await expect(operatorUsername).toHaveValue(updatedCredentials.username);
    await expect(currentPassword).toHaveValue("");
    await expect(newPassword).toHaveValue("");
    await expect(passwordConfirmation).toHaveValue("");
    expect(stepUpRequestCount).toBe(0);

    expectedForbiddenResponses = 1;
    await currentPassword.fill("not the current Operator password");
    await newPassword.fill(updatedCredentials.password);
    await passwordConfirmation.fill(updatedCredentials.password);
    await passwordConfirmation.press("Enter");
    const credentialError = page.locator('.security-form [role="alert"]');
    await expect(credentialError).toContainText("The request was rejected");
    await expect(credentialError).toBeFocused();
    await expect(operatorUsername).toHaveValue(updatedCredentials.username);
    await expect(currentPassword).toHaveValue("");
    await expect(newPassword).toHaveValue("");
    await expect(passwordConfirmation).toHaveValue("");
    expect(stepUpRequestCount).toBe(1);

    await currentPassword.fill(TEST_OPERATOR_CREDENTIALS.password);
    await newPassword.fill(updatedCredentials.password);
    await passwordConfirmation.fill(updatedCredentials.password);
    await passwordConfirmation.press("Enter");
    await expect.poll(() => stepUpRequestCount).toBe(2);
    await expect(page.getByRole("button", { name: "Changing credentials…" })).toBeDisabled();
    await expect(page.locator('.operator-security [role="status"]')).toContainText(
      "Changing credentials",
    );
    releaseSuccessfulStepUp();
    await expect(page.getByRole("heading", { name: "Sign in to Kestrel" })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Credentials changed");

    await page.getByLabel("Username").fill(updatedCredentials.username);
    await page.getByLabel("Password").fill(updatedCredentials.password);
    await page.getByLabel("Password").press("Enter");
    await expect(
      page.getByRole("heading", { level: 1, name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Credentials changed", { exact: false })).toHaveCount(0);
    await expect(page.locator('[data-sidebar="footer"]')).not.toContainText("Signed in as");
    await expect(page.locator('[data-sidebar="footer"]')).not.toContainText(
      updatedCredentials.username,
    );
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
    const finalSignOut = page
      .locator('[data-sidebar="footer"]')
      .getByRole("button", { name: "Sign out", exact: true });
    await finalSignOut.focus();
    await finalSignOut.press("Enter");
    await expect.poll(() => logoutRequestCount).toBe(2);
    await expect(page.getByRole("heading", { name: "Sign in to Kestrel" })).toBeVisible();
    const logoutWarning = page.getByRole("alert");
    await expect(logoutWarning).toContainText(
      "This browser is signed out. Operator logout audit is unavailable",
    );
    await expect(logoutWarning).toBeFocused();
    const remainingCookieNames = (await context.cookies()).map((cookie) => cookie.name);
    expect(remainingCookieNames).not.toContain("__Host-kestrel-session");
    expect(remainingCookieNames).not.toContain("__Host-kestrel-csrf");

    expect(expectedServiceUnavailableResponses).toBe(0);
    expect(expectedForbiddenResponses).toBe(0);
    expect(browserErrors).toEqual([]);
  });
});
