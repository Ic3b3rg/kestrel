import { basename, sep } from "node:path";

import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

function isHashedAsset(filePath: string): boolean {
  return filePath.includes(`${sep}assets${sep}`);
}

export async function registerPwaRoutes(app: FastifyInstance, root: string): Promise<void> {
  await app.register(fastifyStatic, {
    root,
    setHeaders(response, filePath) {
      const fileName = basename(filePath);
      if (
        fileName === "index.html" ||
        fileName === "sw.js" ||
        fileName === "manifest.webmanifest"
      ) {
        response.header("Cache-Control", "no-cache, no-store");
      } else if (isHashedAsset(filePath)) {
        response.header("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        response.header("Cache-Control", "public, max-age=86400");
      }
    },
  });

  app.get("/", (_request, reply) => reply.sendFile("index.html", { immutable: false, maxAge: 0 }));
}
