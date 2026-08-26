import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import type { ProjectUpserted } from "@kestrel/contracts";

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
        head: { objectId: "d".repeat(40), ref: "operator-security" },
        id: "018f0f89-9192-755f-aa96-f72094c734df",
        number: 88,
        observedAt: "2026-08-25T12:01:00.000Z",
        proposalState: "merged",
        providerId: "PR_kestrel",
        title: "Secure and recover the Operator",
      },
    ],
    createdAt: "2026-08-25T12:00:00.000Z",
    id: "018f0f89-949a-75a8-8f61-6df78a843b1f",
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

test.describe("observable Installation PWA", () => {
  let stack: RunningStack | undefined;

  test.beforeAll(async () => {
    stack = await startStack();
    await stack.bootstrapOperator(TEST_OPERATOR_CREDENTIALS);
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
    await expect(page.getByRole("heading", { name: "Kestrel Installation" })).toBeVisible();
    expectedUnauthorizedResponses = 0;
    await expect(page.getByRole("heading", { name: "Public pull requests" })).toBeVisible();
    await expect(page.getByRole("link", { name: "openai/openai-node" })).toBeVisible();
    await expect(page.getByText("Not acquired", { exact: true })).toBeVisible();
    await expect(page.getByText("Public GitHub pull request", { exact: true })).toBeVisible();
    await expect(page.getByText("Manual only", { exact: true })).toBeVisible();
    await expect(page.getByText("Not configured", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh PR #1234" })).toBeVisible();
    await page
      .getByLabel("Public GitHub pull request URL")
      .fill("https://github.com/openai/openai-node");
    await page.getByRole("button", { name: "Open pull request" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Enter a canonical public pull request URL",
    );
    expect(projectPostCount).toBe(0);
    await page.getByLabel("Public GitHub pull request URL").fill(publicPullRequestUrl);
    await page.getByRole("button", { name: "Open pull request" }).click();
    await expect(page.getByRole("link", { name: "Ic3b3rg/kestrel" })).toBeVisible();
    await expect(page.getByText("Base commit", { exact: true })).toHaveCount(2);
    await expect(page.getByText("Head commit", { exact: true })).toHaveCount(2);
    await expect(page.getByRole("status")).toContainText(
      "Project refreshed from the public GitHub pull request.",
    );
    expect(projectPostCount).toBe(1);
    await expect(page.getByText("04 / OPERATOR", { exact: true })).toBeVisible();
    await expect(
      page.getByText(`Signed in as ${TEST_OPERATOR_CREDENTIALS.username}`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Operator security" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Kestrel Installation" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in to Kestrel" })).toHaveCount(0);
    const diagnosticButton = page.getByRole("button", { name: "Run diagnostic" });
    await expect(diagnosticButton).toBeEnabled();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to Installation" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(diagnosticButton).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Succeeded", { exact: true })).toBeVisible();

    const installationId = await page
      .getByRole("definition")
      .filter({ has: page.locator("code") })
      .first()
      .textContent();
    expect(installationId).not.toBeNull();

    await context.setOffline(true);
    await expect(
      page.getByRole("heading", { name: "Reconnect to view product data" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Run diagnostic" })).toBeDisabled();
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
      await expect(page.getByRole("heading", { name: "Kestrel Installation" })).toBeVisible();
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
    await expect(page.getByRole("heading", { name: "Kestrel Installation" })).toBeVisible();
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
