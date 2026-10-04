import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultLifecycleSettings, resolveLifecycleProfile } from "@kestrel/contracts";

test("opens one issue conversation through preparation, a blocked retry, live work and its final answer", async ({
  page,
}, testInfo) => {
  const root = resolve("apps/pwa");
  const entry = join(root, "issue-conversation-acceptance.html");
  const cache = await mkdtemp(join(tmpdir(), "kestrel-issue-conversation-vite-"));
  let server: ViteDevServer | undefined;
  const projectId = "01991c36-7f90-7000-8000-000000000001";
  const startId = "01991c36-7f90-7000-8000-000000000010";
  const featureId = "01991c36-7f90-7000-8000-000000000011";
  const itemId = "01991c36-7f90-7000-8000-000000000012";
  const runId = "01991c36-7f90-7000-8000-000000000013";
  const at = "2026-09-30T12:00:00.000Z";
  const issue = {
    repository: { id: "901", owner: "example", name: "reports" },
    id: "42",
    number: 42,
    url: "https://github.com/example/reports/issues/42",
    title: "Export saved reports",
    state: "open",
    labels: [{ name: "ready-for-agent", color: "008800" }],
  };
  let start: Record<string, unknown> | null = null;
  const updateStart = (patch: Record<string, unknown>) => {
    if (start === null) throw new Error("The issue has not started");
    start = { ...start, ...patch };
  };
  let executionState: "running" | "verified" = "running";
  let planningQuestion = false;
  let answered = false;
  const command = { program: "npm", args: ["test"], cwd: ".", timeoutSeconds: 60 };
  const summary = () => ({
    id: runId,
    workItemId: itemId,
    attempt: 1,
    state: executionState,
    failure: null,
    writerStopped: executionState === "verified",
    createdAt: at,
    startedAt: at,
    completedAt: executionState === "verified" ? at : null,
  });
  const execution = () => ({
    schemaVersion: 1,
    featureId,
    state: executionState,
    failure: null,
    question: null,
    revision: null,
    workItems: [{ id: itemId, key: "EXPORT-1", runs: [summary()] }],
  });
  const run = () => ({
    ...summary(),
    schemaVersion: 1,
    featureId,
    approvedVersion: 1,
    question: null,
    finalSummary: executionState === "verified" ? "Export implemented and checked." : null,
    revision: null,
    runtime: null,
    acceptedCommands: [command],
    activity: [
      { id: itemId, kind: "reasoning", summary: "Checking export behavior", createdAt: at },
      {
        id: startId,
        kind: "subagent",
        summary: "Subagent alpha started",
        itemState: "started",
        agentPath: "/root/alpha",
        createdAt: at,
      },
      {
        id: featureId,
        kind: "command",
        summary: "npm test",
        itemState: "completed",
        agentPath: "/root/alpha",
        detail: "All tests passed",
        exitCode: 0,
        createdAt: at,
      },
    ],
    verification:
      executionState === "verified"
        ? [
            {
              id: featureId,
              round: 1,
              position: 1,
              command,
              headCommitId: "a".repeat(40),
              treeId: "b".repeat(40),
              outcome: "passed",
              exitCode: 0,
              stdout: "All tests passed",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
              durationMs: 100,
              createdAt: at,
            },
          ]
        : [],
  });
  try {
    await writeFile(
      entry,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main id="root" class="p-6"></main><script type="module">
import {createElement,useState} from 'react';import {createRoot} from 'react-dom/client';
import {ProjectFactoryWorkspace} from '/src/ProjectFactoryWorkspace.tsx';import {ProjectIssueConversation} from '/src/ProjectIssueConversation.tsx';import '/src/styles.css';
const projectId='${projectId}';
function App(){const [selected,setSelected]=useState(new URLSearchParams(location.search).get('start'));const navigate=(route)=>{const id=route.kind==='issue'?route.startId:null;history.pushState({},'',id?'?start='+id:location.pathname);setSelected(id)};return selected?createElement(ProjectIssueConversation,{projectId,projectName:'Reports',startId:selected,online:true,onNavigate:navigate,onAuthenticationError:()=>false,onFeatureRead:()=>{},onFeatureUnavailable:()=>{}}):createElement(ProjectFactoryWorkspace,{projectId,projectName:'Reports',online:true,onNavigate:navigate,onAuthenticationError:()=>false})}
createRoot(document.getElementById('root')).render(createElement(App));
</script></body></html>`,
    );
    server = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      configLoader: "native",
      cacheDir: cache,
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (address === null || address === undefined || typeof address === "string")
      throw new Error("No fixture server port");
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/board")) {
        await route.fulfill({
          json: {
            schemaVersion: 1,
            projectId,
            readAt: at,
            planningFeatures: [],
            workItems: [],
            settings: { readyLabel: "ready-for-agent" },
            starts: start === null ? [] : [start],
            github: {
              issues: start === null ? [issue] : [],
              checkedAt: at,
              fetchedAt: at,
              failure: null,
              limited: false,
              retained: false,
            },
          },
        });
      } else if (path.endsWith("/board/start")) {
        start = {
          id: startId,
          issueNumber: 42,
          issueUrl: issue.url,
          title: issue.title,
          state: "queued",
          featureId: null,
          message: null,
        };
        await route.fulfill({ status: 202, json: { id: startId } });
      } else if (path.endsWith(`/board/starts/${startId}`)) {
        await route.fulfill({ json: start });
      } else if (path.endsWith(`/board/starts/${startId}/retry`)) {
        updateStart({ state: "preparing", message: null });
        await route.fulfill({ json: { id: startId } });
      } else if (path.endsWith(`/features/${featureId}/execution/runs/${runId}`)) {
        await route.fulfill({ json: run() });
      } else if (path.endsWith(`/features/${featureId}/execution`)) {
        await route.fulfill({ json: execution() });
      } else if (path.endsWith(`/features/${featureId}/messages`)) {
        answered = true;
        await route.fulfill({ json: { schemaVersion: 1, turnId: startId, messageId: startId } });
      } else if (path.endsWith("/lifecycle-profiles/planning")) {
        const models = [{ id: "fixture-model", displayName: "Fixture model", isDefault: true }];
        await route.fulfill({
          json: {
            phase: "planning",
            versions: { installation: 0, project: 0 },
            defaults: defaultLifecycleSettings,
            overrides: {},
            models,
            blocked: null,
            resolved: {
              ...resolveLifecycleProfile(defaultLifecycleSettings, {}, models),
              phase: "planning",
              versions: { installation: 0, project: 0 },
              skills: [],
            },
          },
        });
      } else if (path.endsWith(`/features/${featureId}`)) {
        await route.fulfill({
          json: {
            schemaVersion: 1,
            feature: {
              schemaVersion: 1,
              id: featureId,
              projectId,
              title: issue.title,
              state: planningQuestion
                ? "planning"
                : executionState === "verified"
                  ? "in_review"
                  : "queued",
              createdAt: at,
              updatedAt: at,
            },
            messages: [
              { id: itemId, role: "user", content: "Temporary planning prompt", createdAt: at },
              ...(answered
                ? [
                    {
                      id: startId,
                      role: "user",
                      content: "Include archived reports.",
                      createdAt: at,
                    },
                  ]
                : []),
            ],
            turns: planningQuestion
              ? [
                  {
                    id: runId,
                    messageId: itemId,
                    state: "failed",
                    failure: "input_required",
                    question: "Should exports include archived reports?",
                    createdAt: at,
                    startedAt: at,
                    completedAt: at,
                  },
                  ...(answered
                    ? [
                        {
                          id: startId,
                          messageId: startId,
                          state: "completed",
                          failure: null,
                          question: null,
                          createdAt: at,
                          startedAt: at,
                          completedAt: at,
                        },
                      ]
                    : []),
                ]
              : [],
            context: null,
          },
        });
      } else {
        await route.fulfill({
          status: 404,
          json: {
            schemaVersion: 1,
            code: "NOT_FOUND",
            message: "Fixture route unavailable",
            correlationId: projectId,
          },
        });
      }
    });
    await page.goto(`http://127.0.0.1:${String(address.port)}/issue-conversation-acceptance.html`);
    await page.evaluate(() => {
      document.cookie = `__Host-kestrel-csrf=${"a".repeat(43)}.${"b".repeat(43)}; path=/; Secure; SameSite=Strict`;
    });
    const startButton = page.getByRole("button", { name: "Start issue #42" });
    await expect(startButton).toBeVisible();
    await startButton.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "Issue conversation" })).toContainText(
      "Waiting for development",
    );
    await expect(page).toHaveURL(new RegExp(`start=${startId}$`));
    updateStart({ state: "preparing" });
    await expect(page.getByRole("region", { name: "Issue conversation" })).toContainText(
      "Preparing development",
    );
    await page.reload();
    await expect(page.getByRole("region", { name: "Issue conversation" })).toContainText(
      "Preparing development",
    );
    updateStart({ state: "blocked", message: "The execution image needs preparation." });
    await expect(page.getByRole("region", { name: "Issue conversation" })).toContainText(
      "The execution image needs preparation.",
    );
    await page.getByRole("button", { name: "Retry preparation" }).click();
    await expect(page.getByRole("region", { name: "Issue conversation" })).toContainText(
      "Preparing development",
    );
    planningQuestion = true;
    updateStart({ state: "blocked", featureId, message: "Planning needs a decision." });
    await expect(page.getByText("Should exports include archived reports?")).toBeVisible();
    const answer = page.getByRole("textbox", { name: "Message" });
    await answer.fill("Include archived reports.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(
      page
        .getByRole("list", { name: "Conversation", exact: true })
        .getByText("Include archived reports.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Retry preparation" }).click();
    planningQuestion = false;
    updateStart({ state: "running", featureId });
    await expect(page.getByRole("region", { name: "Feature execution" })).toContainText(
      "Working on this issue…",
    );
    await expect(page.getByRole("region", { name: "Live activity" })).toContainText(
      "Checking export behavior",
    );
    await expect(page.getByText("Subagent alpha · Working")).toBeVisible();
    executionState = "verified";
    updateStart({ state: "done" });
    await expect(page.getByText("Export implemented and checked.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Live activity" })).toContainText(
      "Checking export behavior",
    );
    await expect(page.getByRole("tablist", { name: "Feature views" })).toHaveCount(0);
    await expect(page.getByText("Temporary planning prompt")).toHaveCount(0);
    await expect(page.getByText("1 of 1 checks passed in the latest round.")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.reload();
    await expect(page.getByText("Export implemented and checked.")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("issue-final-narrow.png"), fullPage: true });
    await page.getByRole("link", { name: "Reports board" }).click();
    await expect(page.getByRole("button", { name: "Open issue conversation #42" })).toBeVisible();
    await page.getByRole("button", { name: "Open issue conversation #42" }).click();
    await expect(page).toHaveURL(new RegExp(`start=${startId}$`));
  } finally {
    await server?.close();
    await rm(entry, { force: true });
    await rm(cache, { recursive: true, force: true });
  }
});
