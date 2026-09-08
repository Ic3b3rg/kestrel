import { randomUUID } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  FactoryExecutionSchema,
  FeatureSchema,
  LocalRepositoryInventorySchema,
  ProjectUpsertedSchema,
  type FeaturePlanDocument,
} from "@kestrel/contracts";
import { startStack, TEST_OPERATOR_CREDENTIALS, type RunningStack } from "./support/compose.js";
import { createGitFixture } from "./support/git-fixture.js";
import { factoryGitHubFixture } from "./support/factory-github-fixture.js";

test.describe("Human Gate decisions", () => {
  let stack: RunningStack;
  const cleanup: Array<() => Promise<void>> = [];
  let projectId: string;
  let featureId: string;
  const question = "Should equal values retain their original order?";
  const answer = "Keep the original order, within the approved stable-order requirement.";
  const endpoint = () => `/api/v1/projects/${projectId}/features/${featureId}`;
  const post = (path: string, body: unknown) =>
    stack.fetchApi(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  test.beforeAll(async () => {
    const fixture = await createGitFixture();
    cleanup.push(() => fixture.close());
    stack = await startStack({
      repositoryRoot: fixture.rootPath,
      githubFixture: factoryGitHubFixture,
    });
    cleanup.push(() => stack.close());
    await stack.authenticateOperator();
    await stack.executeSql(`CREATE FUNCTION hold_browser_gate_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='factory-execution-v1' THEN NEW.start_after=clock_timestamp()+interval '1 hour'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER hold_browser_gate_delivery BEFORE INSERT ON pgboss.job FOR EACH ROW EXECUTE FUNCTION hold_browser_gate_delivery();`);
    const inventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const repository = inventory.repositories.find((entry) => entry.displayName === "kestrel");
    if (repository === undefined) throw new Error("Gate fixture repository missing");
    projectId = ProjectUpsertedSchema.parse(
      await (
        await post("/api/v1/projects/local", { repositoryId: repository.repositoryId })
      ).json(),
    ).project.id;
    featureId = FeatureSchema.parse(
      await (
        await post(`/api/v1/projects/${projectId}/features`, {
          requestId: randomUUID(),
          title: "Stable result order",
        })
      ).json(),
    ).id;
    const plan: FeaturePlanDocument = {
      objective: "Keep results in stable order",
      scope: { includes: ["Stable ordering"], excludes: ["New filters"] },
      acceptance: [{ key: "order", outcome: "Equal values retain their original order" }],
      workItems: [
        {
          key: "order",
          title: "Retain original order",
          description: "Make ordering stable for equal values.",
          requirementKeys: ["order"],
          acceptance: ["Equal values retain their original order"],
          importedIssueId: null,
          dependsOn: [],
          verification: [
            { program: "node", args: ["--test", "order.test.mjs"], cwd: ".", timeoutSeconds: 60 },
          ],
        },
      ],
      limits: {
        maxConcurrentProjects: 2,
        maxActiveFeaturesPerProject: 1,
        attemptTimeoutSeconds: 120,
      },
    };
    expect(
      (await post(`${endpoint()}/plans`, { requestId: randomUUID(), expectedVersion: null, plan }))
        .status,
    ).toBe(201);
    expect((await post(`${endpoint()}/plans/1/approve`, { requestId: randomUUID() })).status).toBe(
      200,
    );
    await expect
      .poll(
        async () =>
          ((await (await stack.fetchApi(`${endpoint()}/publication`)).json()) as { state: string })
            .state,
        { timeout: 25_000 },
      )
      .toBe("published");
    await stack.executeWebModule(`
      import { randomUUID } from 'node:crypto';
      import { createPool,createPgBoss,queueFactoryExecutions,claimFactoryExecution,finishFactoryExecution } from '@kestrel/database';
      const pool=createPool(process.env.DATABASE_URL); const boss=createPgBoss({applicationName:'gate-browser-test',databaseUrl:process.env.DATABASE_URL});
      try {
        await boss.start(); await queueFactoryExecutions(pool,boss);
        const {rows}=await pool.query('SELECT id FROM factory_execution_runs WHERE feature_id=$1',[${JSON.stringify(featureId)}]);
        const run=await claimFactoryExecution(pool,rows[0].id,randomUUID()); if(!run) throw new Error('No controlled fixture worker');
        await finishFactoryExecution(pool,run,{verified:false,writerStopped:true,failure:'input_required',question:${JSON.stringify(question)}});
      } finally { await boss.stop(); await pool.end(); }
    `);
  });
  test.afterAll(async () => {
    for (const close of cleanup.toReversed()) await close();
  });

  test("answers the concrete question, restores its history, and cancels the queued successor", async ({
    page,
    context,
  }, testInfo) => {
    await page.goto(stack.pwaUrl);
    await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
    await page.getByLabel("Password", { exact: true }).fill(TEST_OPERATOR_CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("region", { name: "Sign in to Kestrel" })).toHaveCount(0);
    await page.goto(`${stack.pwaUrl}/projects/${projectId}/features/${featureId}?view=board`);
    const gate = page.getByRole("region", { name: "Human gate", exact: true });
    await expect(gate.getByRole("heading", { name: "Your decision is needed" })).toBeVisible();
    await expect(gate.getByText(question, { exact: true })).toBeVisible();
    const card = page.getByRole("button", { name: "1. Retain original order", exact: true });
    await expect(card).toContainText(question);
    await expect(gate.getByRole("button", { name: "Save answer and resume" })).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await gate.getByLabel("Your answer", { exact: true }).fill(answer);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).include('[aria-label="Human gate"]').analyze()).violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("gate-question-mobile.png"),
      fullPage: true,
    });
    await context.setOffline(true);
    await expect(gate.getByRole("button", { name: "Save answer and resume" })).toBeDisabled();
    await context.setOffline(false);
    await expect(gate.getByRole("button", { name: "Save answer and resume" })).toBeEnabled();
    await gate.getByRole("button", { name: "Save answer and resume" }).click();
    await expect
      .poll(
        async () =>
          FactoryExecutionSchema.parse(
            await (await stack.fetchApi(`${endpoint()}/execution`)).json(),
          ).workItems[0]?.runs.length,
        { timeout: 15_000 },
      )
      .toBe(2);
    await expect(
      page.getByText("Decision needed · Review the blocked work on the board.", { exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await page.getByRole("button", { name: /Attempt 1 · Needs attention/ }).click();
    const history = page.getByRole("region", { name: "Attempt 1 details" });
    await expect(history).toContainText("Answer saved");
    await expect(history).toContainText(answer);
    await expect(history).toContainText("One follow-up attempt was created");
    await page.getByRole("button", { name: "View plan", exact: true }).click();
    await page.getByRole("button", { name: "Cancel feature", exact: true }).click();
    const cancellation = page.getByRole("dialog", { name: /Cancel/ });
    await cancellation.getByRole("button", { name: "Cancel feature", exact: true }).click();
    await expect(cancellation).toHaveCount(0);
    await page.goto(`${stack.pwaUrl}/projects/${projectId}/features/${featureId}?view=board`);
    await expect(
      page.getByRole("region", { name: "Feature execution", exact: true }),
    ).toContainText("Execution cancelled");
    await page.reload();
    await expect(
      page.getByRole("region", { name: "Feature execution", exact: true }),
    ).toContainText("Execution cancelled");
    const confirmed = FactoryExecutionSchema.parse(
      await (await stack.fetchApi(`${endpoint()}/execution`)).json(),
    );
    expect(confirmed.workItems[0]?.runs).toHaveLength(2);
    expect(confirmed.workItems[0]?.runs[1]).toMatchObject({
      state: "cancelled",
      writerStopped: true,
    });
  });
});
