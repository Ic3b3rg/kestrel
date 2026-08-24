import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InstallationSnapshotSchema } from "@kestrel/contracts";

import { startStack, type RunningStack } from "./support/compose.js";

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.json();
}

describe("observable Kestrel Installation", () => {
  let stack: RunningStack | undefined;

  beforeAll(async () => {
    stack = await startStack();
  });

  afterAll(async () => {
    await stack?.close();
  });

  it("exposes the same persisted Installation across a web restart", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;

    const before = InstallationSnapshotSchema.parse(
      await getJson(`${runningStack.apiUrl}/api/v1/installation`),
    );
    await runningStack.restart("web");
    const after = InstallationSnapshotSchema.parse(
      await getJson(`${runningStack.apiUrl}/api/v1/installation`),
    );

    expect(after).toEqual(before);
  }, 60_000);

  it("serves the generated OpenAPI contract", async () => {
    expect(stack).toBeDefined();
    const document = await getJson(`${(stack as RunningStack).apiUrl}/api/v1/openapi.json`);

    expect(document).toMatchObject({
      openapi: "3.1.1",
      paths: {
        "/api/v1/events": {},
        "/api/v1/installation": {},
        "/api/v1/installation/diagnostics": {},
      },
    });
  });

  it("serves the production PWA shell with cache-safe boundaries", async () => {
    expect(stack).toBeDefined();
    const apiUrl = (stack as RunningStack).apiUrl;
    const shellResponse = await fetch(apiUrl);
    expect(shellResponse.status).toBe(200);
    expect(shellResponse.headers.get("cache-control")).toBe("no-cache, no-store");
    const shell = await shellResponse.text();
    expect(shell).toContain("<title>Kestrel Installation</title>");

    const assetUrls = [...shell.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/gu)]
      .map((match) => match[1])
      .filter((url): url is string => url !== undefined);
    expect(assetUrls).toHaveLength(2);
    for (const assetUrl of assetUrls) {
      const asset = await fetch(new URL(assetUrl, apiUrl));
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    }

    const manifestResponse = await fetch(`${apiUrl}/manifest.webmanifest`);
    expect(manifestResponse.headers.get("cache-control")).toBe("no-cache, no-store");
    await expect(manifestResponse.json()).resolves.toMatchObject({
      id: "/",
      name: "Kestrel Installation",
      start_url: "/",
    });

    const serviceWorkerResponse = await fetch(`${apiUrl}/sw.js`);
    expect(serviceWorkerResponse.headers.get("cache-control")).toBe("no-cache, no-store");
    const serviceWorker = await serviceWorkerResponse.text();
    expect(serviceWorker).toContain("precacheAndRoute");
    expect(serviceWorker).toContain("/^\\/api\\//");
    expect(serviceWorker).not.toContain("/api/v1/installation");
  });
});
