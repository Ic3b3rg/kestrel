import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { defaultLifecycleSettings, resolveLifecycleProfile } from "@kestrel/contracts";
import { createServer, type ViteDevServer } from "vite";
import { writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

test("reads formatted planning replies while keeping the composer editable", async ({
  page,
}, testInfo) => {
  const root = resolve("apps/pwa");
  const entry = join(root, "planning-markdown-acceptance.html");
  const cache = await mkdtemp(join(tmpdir(), "kestrel-planning-markdown-"));
  let server: ViteDevServer | undefined;
  const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
  const featureId = "018f0f89-9192-755f-aa96-f72094c734df";
  const at = "2026-09-28T12:00:00.000Z";
  const chat = {
    schemaVersion: 1,
    feature: {
      schemaVersion: 1,
      id: featureId,
      projectId,
      title: "Search reports",
      state: "planning",
      createdAt: at,
      updatedAt: at,
    },
    messages: [
      { id: projectId, role: "user", content: "Search **saved reports**.", createdAt: at },
      {
        id: featureId,
        role: "assistant",
        content:
          "## Proposed steps\n\n- [x] Read requirements\n- [ ] Build search\n\n| Step | Result |\n| --- | --- |\n| Search | Matching reports |\n\n```ts\nconst query = 'reports';\n```\n\n[Documentation](https://example.com/docs)\n\n<script>window.unsafePlan = true</script>",
        createdAt: at,
      },
    ],
    turns: [],
    context: null,
  };
  try {
    await writeFile(
      entry,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Planning conversation</title></head><body><main id="root" class="p-4"></main><script type="module">
import {createElement} from 'react';import {createRoot} from 'react-dom/client';
import {FeatureChatPanel} from '/src/FeatureChatPanel.tsx';import '/src/styles.css';
const noop=()=>{}; const auth=()=>false;
createRoot(document.getElementById('root')).render(createElement(FeatureChatPanel,{projectId:'${projectId}',featureId:'${featureId}',projectName:'Reports',online:true,onNavigate:noop,onAuthenticationError:auth,onFeatureRead:noop,onFeatureUnavailable:noop}));
</script></body></html>`,
    );
    server = await createServer({
      root,
      configFile: join(root, "vite.config.ts"),
      configLoader: "native",
      cacheDir: cache,
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith(`/features/${featureId}`)) return route.fulfill({ json: chat });
      if (path.includes("/lifecycle-profiles/")) {
        const models = [{ id: "fixture-model", displayName: "Fixture model", isDefault: true }];
        return route.fulfill({
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
      }
      await route.abort();
    });
    await page.goto(`http://127.0.0.1:${String(address.port)}/planning-markdown-acceptance.html`);
    const reply = page.getByRole("article", { name: "Kestrel reply" });
    await expect(reply.getByRole("heading", { name: "Proposed steps" })).toBeVisible();
    await expect(
      page.getByRole("article", { name: "Your message" }).locator("strong").last(),
    ).toHaveText("saved reports");
    await expect(reply.getByRole("table")).toContainText("Matching reports");
    await expect(reply.getByRole("checkbox").first()).toBeDisabled();
    await expect(reply.locator("pre code")).toContainText("const query = 'reports';");
    expect(await page.evaluate(() => "unsafePlan" in window)).toBe(false);
    const composer = page.locator("#planning-message");
    await composer.fill("Keep **this draft** editable.");
    await expect(composer).toHaveValue("Keep **this draft** editable.");
    await reply.getByRole("link", { name: "Documentation" }).focus();
    await expect(reply.getByRole("link", { name: "Documentation" })).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath("planning-markdown-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 320, height: 812 });
    expect(
      await reply.evaluate(
        (element) =>
          element.scrollWidth <= element.clientWidth &&
          element.getBoundingClientRect().right <= innerWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("planning-markdown-narrow.png"),
      fullPage: true,
    });
  } finally {
    await server?.close();
    await rm(entry, { force: true });
    await rm(cache, { recursive: true, force: true });
  }
});
