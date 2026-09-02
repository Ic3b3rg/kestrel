import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerPwaRoutes } from "./pwa.js";

describe("PWA routes", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
  });

  it("serves the application shell for stable Project and Settings deep links", async () => {
    const root = await mkdtemp(join(tmpdir(), "kestrel-pwa-routes-"));
    roots.push(root);
    await writeFile(join(root, "index.html"), "<!doctype html><title>Kestrel shell</title>");
    const app = Fastify({ logger: false });
    await registerPwaRoutes(app, root);

    try {
      for (const url of ["/projects/018f0f89-949a-75a8-8f61-6df78a843b1e", "/settings"]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode).toBe(200);
        expect(response.body).toContain("Kestrel shell");
        expect(response.headers["cache-control"]).toBe("no-cache, no-store");
      }
      expect((await app.inject({ method: "GET", url: "/unknown" })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
