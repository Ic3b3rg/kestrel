import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { createServer, type ViteDevServer } from "vite";
import { writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// Browser acceptance for the actual board entry component. All provider/API traffic is fixture-owned.
test("reads issues in-app, starts by drop, retains queued work, and supports narrow keyboard use", async ({
  page,
}, testInfo) => {
  const root = resolve("apps/pwa");
  const entry = join(root, "board-acceptance.html");
  const cache = await mkdtemp(join(tmpdir(), "kestrel-board-vite-"));
  let server: ViteDevServer | undefined;
  const projectId = "01991c36-7f90-7000-8000-000000000001";
  const issue = {
    repository: { id: "901", owner: "example", name: "reports" },
    id: "42",
    number: 42,
    url: "https://github.com/example/reports/issues/42",
    title: "Export saved reports",
    state: "open",
    labels: [
      { name: "ready-for-agent", color: "008800" },
      { name: "enhancement", color: "666666" },
    ],
    commentCount: 2,
  };
  const starts: Array<unknown> = [];
  let commands = 0;
  let reads = 0;
  try {
    await writeFile(
      entry,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Project board acceptance</title></head><body><main id="root" class="p-6"></main><script type="module">
import {createElement} from 'react'; import {createRoot} from 'react-dom/client';
import {ProjectFactoryWorkspace} from '/src/ProjectFactoryWorkspace.tsx';import '/src/styles.css';
const auth=()=>false;createRoot(document.getElementById('root')).render(createElement(ProjectFactoryWorkspace,{projectId:'${projectId}',projectName:'Reports',online:true,onNavigate:()=>{},onAuthenticationError:auth}));
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
      const url = new URL(route.request().url());
      const at = new Date().toISOString();
      if (url.pathname.endsWith("/board")) {
        reads++;
        await route.fulfill({
          json: {
            schemaVersion: 1,
            projectId,
            readAt: at,
            planningFeatures: [],
            workItems: [],
            settings: { readyLabel: "ready-for-agent" },
            starts,
            github: {
              issues: starts.length ? [] : [issue],
              checkedAt: at,
              fetchedAt: at,
              failure: null,
              limited: false,
              retained: false,
            },
          },
        });
        return;
      }
      if (url.pathname.endsWith("/issues/42")) {
        await route.fulfill({
          json: {
            issue: {
              ...issue,
              body: "Export every selected report.\n<script>window.unsafeIssue = true</script>",
              dependencies: [],
            },
            comments: [
              {
                id: "71",
                body: "Keep Unicode intact.",
                author: "operator",
                url: issue.url + "#issuecomment-71",
              },
              {
                id: "72",
                body: "Include the report title.",
                author: "reviewer",
                url: issue.url + "#issuecomment-72",
              },
            ],
            nextPage: null,
            fetchedAt: at,
            failure: null,
          },
        });
        return;
      }
      if (url.pathname.endsWith("/start")) {
        commands++;
        const body = route.request().postDataJSON();
        expect(body.issueNumber).toBe(42);
        starts.push({
          id: projectId,
          issueNumber: 42,
          issueUrl: issue.url,
          title: issue.title,
          state: "queued",
          featureId: null,
          message: null,
        });
        await route.fulfill({ status: 202, json: { id: projectId } });
        return;
      }
      await route.abort();
    });
    await page.goto(`http://127.0.0.1:${address.port}/board-acceptance.html`);
    await page.evaluate(() => {
      document.cookie = `__Host-kestrel-csrf=${"a".repeat(43)}.${"b".repeat(43)}; path=/; Secure; SameSite=Strict`;
    });
    await expect(
      page.getByRole("button", { name: "Open issue #42: Export saved reports", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("2 comments", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Open issue #42: Export saved reports", exact: true })
      .click();
    const reader = page.getByRole("dialog");
    await expect(reader.getByText("Keep Unicode intact.", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => "unsafeIssue" in window)).toBe(false);
    await page.keyboard.press("Escape");
    await expect(reader).toHaveCount(0);
    const card = page
      .getByRole("button", { name: "Open issue #42: Export saved reports", exact: true })
      .locator("..");
    await card.dragTo(page.getByRole("region", { name: "In progress", exact: true }));
    await expect(page.getByRole("region", { name: "In progress", exact: true })).toContainText(
      "Waiting for development",
    );
    expect(commands).toBe(1);
    await page.reload();
    await expect(page.getByRole("region", { name: "In progress", exact: true })).toContainText(
      "Export saved reports",
    );
    await page.screenshot({ path: testInfo.outputPath("board-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole("region", { name: "Completed", exact: true })).toContainText(
      "Work appears here as it progresses.",
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole("button", { name: "#42 Export saved reports", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toContainText("Include the report title.");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("issue-narrow.png"), fullPage: true });
    expect(reads).toBeGreaterThanOrEqual(2);
  } finally {
    await server?.close();
    await rm(entry, { force: true });
    await rm(cache, { recursive: true, force: true });
  }
});
