import { randomUUID } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { TEST_OPERATOR_CREDENTIALS } from "./support/compose.js";
import {
  createVerificationFixture,
  processVerificationFixture,
  releaseVerificationPause,
  type VerificationFixture,
} from "./support/factory-verification-fixture.js";

test.describe("Final Feature verification evidence and decisions", () => {
  let fixture: VerificationFixture;
  let featureId: string;
  let finalRunId: string;
  const cleanup: Array<() => Promise<void>> = [];
  const itemRuns: string[] = [];
  async function nextRun() {
    const queued = await fixture.queue(featureId);
    expect(queued).toHaveLength(1);
    const id = queued[0];
    if (id === undefined) throw new Error("Expected one queued verification worker");
    return id;
  }
  test.beforeAll(async () => {
    fixture = await createVerificationFixture();
    cleanup.push(() => fixture.close());
    featureId = await fixture.approve("Preserve ordering across the whole Feature");
    for (const mode of ["order", "break_consumer"] as const) {
      const id = await nextRun();
      itemRuns.push(id);
      expect(await processVerificationFixture(fixture.stack, id, mode)).toMatchObject({
        error: null,
      });
    }
    finalRunId = await nextRun();
  });
  test.afterAll(async () => {
    for (const close of cleanup.toReversed()) await close();
  });

  test("explains final progress, retains the failure, and certifies only a resumed complete pass", async ({
    page,
  }, testInfo) => {
    await page.goto(fixture.stack.pwaUrl);
    await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
    await page.getByLabel("Password", { exact: true }).fill(TEST_OPERATOR_CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("region", { name: "Sign in to Kestrel" })).toHaveCount(0);
    await page.goto(
      `${fixture.stack.pwaUrl}/projects/${fixture.projectId}/features/${featureId}?view=board`,
    );
    const execution = page.getByRole("region", { name: "Feature execution", exact: true });
    const final = page.getByRole("region", { name: "Final Feature verification", exact: true });
    await expect(final.getByText(/No final verification record yet/)).toBeVisible();
    await expect(
      final.getByRole("button", { name: "Final attempt 1 · Queued", exact: true }),
    ).toBeVisible();
    await expect(
      execution.getByText("Final Feature revision verified", { exact: true }),
    ).toHaveCount(0);

    // Requirements remain attached to the original verified Work Items.
    const orderCard = page.getByRole("button", { name: "1. Retain original order", exact: true });
    await orderCard.focus();
    await orderCard.press("Enter");
    const item = page.getByRole("dialog", { name: "Retain original order", exact: true });
    await expect(item.getByRole("heading", { name: "Requirements", exact: true })).toBeVisible();
    await expect(item.getByText("stable-order", { exact: true })).toBeVisible();
    await expect(
      item.getByText("Equal values retain their original order", { exact: true }),
    ).toBeVisible();
    await expect(item.getByText(/order.test.mjs/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(orderCard).toBeFocused();

    const token = randomUUID();
    const processing = processVerificationFixture(fixture.stack, finalRunId, "keep", {
      token,
      position: 2,
    });
    try {
      await expect
        .poll(async () => (await fixture.execution(featureId)).finalVerification?.progress?.checked)
        .toBe(1);
      await execution.getByRole("button", { name: "Refresh execution", exact: true }).click();
      await expect(
        final.getByText("Pass 1 · 1 of 3 checks recorded · 0 passed", { exact: true }),
      ).toBeVisible();
      const attempt = final.getByRole("button", {
        name: "Final attempt 1 · Verifying",
        exact: true,
      });
      await attempt.focus();
      await attempt.press("Enter");
      const details = final.getByRole("region", { name: "Final attempt 1 details", exact: true });
      await expect(
        details.getByText("order · command 2; consumer · command 2", { exact: true }),
      ).toBeVisible();
      await expect(details.getByText("Round 1 · Check 1 · Failed", { exact: true })).toBeVisible();
      const failedCheck = details
        .getByText("Round 1 · Check 1 · Failed", { exact: true })
        .locator("..");
      await expect(
        failedCheck.getByText('["node","--test","order.test.mjs"]', { exact: true }),
      ).toBeVisible();
      const output = failedCheck.getByText("Captured output and revision", { exact: true });
      await output.focus();
      await output.press("Enter");
      await expect(
        failedCheck.getByLabel("stdout for round 1 check 1", { exact: true }),
      ).toContainText("equal values retain their original order");
      const current = await fixture.run(featureId, finalRunId);
      if (current.revision === null) throw new Error("Final checked revision missing");
      await expect(
        failedCheck.getByText(current.revision.headCommitId, { exact: true }),
      ).toBeVisible();
      await expect(
        details.getByText("Execution environment stop has not been confirmed.", { exact: true }),
      ).toBeVisible();
      expect((await fixture.execution(featureId)).finalVerification?.certificate).toBeNull();
      await page.screenshot({
        path: testInfo.outputPath("final-verification-progress-desktop.png"),
        fullPage: true,
      });
    } finally {
      await releaseVerificationPause(fixture.stack, token);
      expect(await processing).toMatchObject({ error: null });
    }

    await execution.getByRole("button", { name: "Refresh execution", exact: true }).click();
    const gate = page.getByRole("region", { name: "Human gate", exact: true });
    await expect(
      gate.getByRole("heading", { name: "Your decision is needed", exact: true }),
    ).toBeVisible();
    await expect(
      gate.getByText("Final Feature verification · plan version 1", { exact: true }),
    ).toBeVisible();
    await expect(gate.getByText(/Final Feature verification failed checks 1/)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    const answer =
      "Restore ordering within approved plan version 1 and rerun every original check.";
    await gate.getByLabel("Your answer", { exact: true }).fill(answer);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).include('[aria-label="Feature execution"]').analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("final-verification-gate-mobile.png"),
      fullPage: true,
    });
    const resume = gate.getByRole("button", { name: "Save answer and resume", exact: true });
    await resume.focus();
    await resume.press("Enter");
    await expect
      .poll(async () => (await fixture.execution(featureId)).finalVerification?.runs.length)
      .toBe(2);
    const successor = await nextRun();
    expect(
      (await fixture.execution(featureId)).workItems.map((work) => work.runs.map((run) => run.id)),
    ).toEqual(itemRuns.map((id) => [id]));
    await page.reload();
    await final
      .getByRole("button", { name: "Final attempt 1 · Needs attention", exact: true })
      .click();
    const retained = final.getByRole("region", { name: "Final attempt 1 details", exact: true });
    await expect(retained.getByText(answer, { exact: true })).toBeVisible();
    await expect(
      retained.getByText(
        "Only final verification resumes. Verified Work Item implementations are retained.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(retained.getByText("Round 3 · Check 1 · Failed", { exact: true })).toBeVisible();

    expect(await processVerificationFixture(fixture.stack, successor, "repair")).toMatchObject({
      error: null,
    });
    await execution.getByRole("button", { name: "Refresh execution", exact: true }).click();
    await expect(
      execution.getByText("Final Feature revision verified", { exact: true }),
    ).toBeVisible();
    await expect(
      final.getByText("All 3 approved checks passed · plan version 1.", { exact: true }),
    ).toBeVisible();
    await expect(
      final.getByText(/No pull request has been published by this verification/),
    ).toBeVisible();
    const confirmed = await fixture.execution(featureId);
    const certificate = confirmed.finalVerification?.certificate;
    if (certificate == null) throw new Error("Certified record missing");
    const revision = final.getByText("Certified revision", { exact: true });
    await revision.focus();
    await revision.press("Enter");
    await expect(final.getByText(certificate.revision.headCommitId, { exact: true })).toBeVisible();
    await expect(final.getByText(certificate.revision.treeId, { exact: true })).toBeVisible();
    expect(confirmed.workItems.map((work) => work.runs.length)).toEqual([1, 1]);
    expect(
      (await fixture.board(featureId)).columns.find((column) => column.id === "completed")?.items,
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).include('[aria-label="Feature execution"]').analyze())
        .violations,
    ).toEqual([]);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: testInfo.outputPath("final-verification-certified-desktop.png"),
      fullPage: true,
    });
  });
});
