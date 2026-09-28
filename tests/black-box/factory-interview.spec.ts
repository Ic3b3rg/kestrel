import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { FactoryExecutionSchema, FeatureChatSchema } from "@kestrel/contracts";
import { startStack, TEST_OPERATOR_CREDENTIALS, type RunningStack } from "./support/compose.js";
import { createGitFixture, type GitFixture } from "./support/git-fixture.js";
import { codexConnectionFixture } from "./support/codex-connection-fixture.js";
import { factoryGitHubFixture } from "./support/factory-github-fixture.js";
import { verificationPlan } from "./support/factory-verification-fixture.js";

const planningFixture = codexConnectionFixture.replace(
  "const { id, method } = JSON.parse(line);",
  `const { id, method, params } = JSON.parse(line);
  const send = value => console.log(JSON.stringify(value));
  if (method === 'config/read') { send({id,result:{config:{features:{apps:false,plugins:false,hooks:false,browser_use:false,browser_use_external:false,shell_tool:false},web_search:'disabled',allow_login_shell:false}}});return; }
  if (method === 'thread/start') { send({id,result:{thread:{id:'interview-thread'},cwd:params.cwd,sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'never',approvalsReviewer:'user',model:params.model,modelProvider:'openai'}});return; }
  if (method === 'turn/start') {
    send({id,result:{turn:{id:'interview-turn',status:'inProgress'}}});
    const prompt = params.input[0].text;
    const section = prompt.split('<selected_planning_skills>')[1]?.split('</selected_planning_skills>')[0];
    const name = JSON.parse(section || '[]')[0]?.name || 'none';
    const text = params.outputSchema ? ${JSON.stringify(JSON.stringify(verificationPlan()))} : '## Interview findings\\n\\nProcedure: **'+name+'**\\n\\n- Which outcome matters?\\n- What must stay unchanged?\\n\\n\x60\x60\x60text\\nFree-form answers are welcome.\\n\x60\x60\x60';
    send({method:'item/completed',params:{threadId:params.threadId,turnId:'interview-turn',item:{id:'answer',type:'agentMessage',phase:'final_answer',text}}});
    send({method:'turn/completed',params:{threadId:params.threadId,turn:{id:'interview-turn',status:'completed'}}});return;
  }`,
);

test.describe("Interview to individual issue", () => {
  let stack: RunningStack;
  let source: GitFixture;
  test.beforeAll(async () => {
    source = await createGitFixture();
    stack = await startStack({
      connectedCodexFixture: true,
      planningCodexFixture: planningFixture,
      repositoryRoot: source.rootPath,
      githubFixture: factoryGitHubFixture,
    });
    await stack.bootstrapOperator(TEST_OPERATOR_CREDENTIALS);
    await stack.executeSql(
      `CREATE FUNCTION hold_interview_execution() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='factory-execution-v1' THEN NEW.start_after=clock_timestamp()+interval '1 hour'; END IF; RETURN NEW; END $$; CREATE TRIGGER hold_interview_execution BEFORE INSERT ON pgboss.job FOR EACH ROW EXECUTE FUNCTION hold_interview_execution();`,
    );
  });
  test.afterAll(async () => {
    try {
      await stack.close();
    } finally {
      await source.close();
    }
  });
  test("uses the configured procedure, preserves a draft, renders Markdown and starts only the dragged issue", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(stack.pwaUrl);
    await page.getByLabel("Username").fill(TEST_OPERATOR_CREDENTIALS.username);
    await page.getByLabel("Password", { exact: true }).fill(TEST_OPERATOR_CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Open Project", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Open an authorized repository" });
    const id = await dialog
      .getByRole("option")
      .filter({ hasText: "kestrel" })
      .first()
      .getAttribute("value");
    if (id === null) throw new Error("Repository missing");
    await dialog.getByLabel("Repository", { exact: true }).selectOption(id);
    await dialog.getByRole("button", { name: "Open selected Project" }).click();
    await expect(dialog).toHaveCount(0);
    const projectUrl = page.url();
    await page.goto(projectUrl + "/settings");
    await page.getByLabel("Inherit Installation Skills").uncheck();
    await page.getByLabel(/^grill-with-docs ·/).uncheck();
    await page.getByLabel(/^brainstorming ·/).check();
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await expect(page.getByText("Profile saved for future work.", { exact: false })).toBeVisible();
    await page.goto(projectUrl);
    await page
      .getByRole("main")
      .getByRole("button", { name: "New interview", exact: true })
      .click();
    const trigger = page.getByRole("button", { name: "Choose interview skill" });
    await expect(trigger).toContainText("brainstorming");
    await expect(page.getByLabel("Search skills or collections")).toHaveCount(0);
    const draft = page.getByLabel("Describe the change", { exact: true });
    await draft.fill("Preserve stable ordering and add its consumer.");
    await page.setViewportSize({ width: 320, height: 800 });
    await trigger.click();
    await page.getByLabel("Search skills or collections").fill("Matt Pocock");
    await expect(page.getByRole("button", { name: /grill-with-docs Matt Pocock/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(draft).toHaveValue("Preserve stable ordering and add its consumer.");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page
      .getByRole("main")
      .getByRole("button", { name: "Start interview", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "Interview findings" })).toBeVisible();
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await expect(page.locator("strong").filter({ hasText: "brainstorming" })).toBeVisible();
    const featureUrl = page.url();
    const chatPath = "/api/v1" + new URL(featureUrl).pathname;
    const chat = () =>
      page
        .evaluate(async (path) => (await fetch(path)).json() as Promise<unknown>, chatPath)
        .then((value) => FeatureChatSchema.parse(value));
    expect((await chat()).turns[0]?.skills?.map(({ name }) => name)).toEqual(["brainstorming"]);
    await page.getByLabel("Message", { exact: true }).fill("Keep the first result stable.");
    await trigger.click();
    await page.getByLabel("Search skills or collections").fill("Matt Pocock");
    await page.getByRole("button", { name: /grill-with-docs Matt Pocock/ }).click();
    await expect(trigger).toContainText("grill-with-docs");
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
      "Keep the first result stable.",
    );
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator("strong").filter({ hasText: "grill-with-docs" })).toBeVisible();
    expect((await chat()).turns.at(-1)?.skills?.map(({ name }) => name)).toEqual([
      "grill-with-docs",
    ]);
    await page.reload();
    await expect(trigger).toContainText("grill-with-docs");
    await page.screenshot({
      path: test.info().outputPath("interview-mobile.png"),
      animations: "disabled",
    });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Review requirements", exact: true }).click();
    await page.getByRole("button", { name: "Prepare requirements", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Review requirements", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Issue drafts", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Review issue drafts", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Issue drafts", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Publish issues", exact: true }).click();
    await expect(page.getByText("GitHub issues published", { exact: false })).toBeVisible();
    await page.goto(projectUrl);
    const todo = page.getByRole("region", { name: "To do", exact: true });
    const inProgress = page.getByRole("region", { name: "In progress", exact: true });
    const chosen = todo.locator("li").filter({ hasText: "Retain original order" });
    await expect(chosen).toBeVisible();
    const execution = FactoryExecutionSchema.parse(
      await page.evaluate(
        async (path) => (await fetch(path + "/execution")).json() as Promise<unknown>,
        chatPath,
      ),
    );
    expect(execution.workItems.flatMap((item) => item.runs)).toEqual([]);
    await chosen.dragTo(inProgress);
    await expect(chosen).toContainText("Start requested");
    await expect(todo.locator("li").filter({ hasText: "Add the consumer" })).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("individual-start-board.png"),
      animations: "disabled",
    });
    expect(errors).toEqual([]);
    await page.goto(projectUrl + "/settings");
    await expect(page.getByLabel(/^brainstorming ·/)).toBeChecked();
    await expect(page.getByLabel(/^grill-with-docs ·/)).not.toBeChecked();
  });
});
