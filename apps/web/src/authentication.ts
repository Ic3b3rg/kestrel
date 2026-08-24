import type { FastifyInstance } from "fastify";

import { ApiErrorSchema, type Session } from "@kestrel/contracts";

import { readSessionCookie, verifySessionToken } from "./session.js";

declare module "fastify" {
  interface FastifyRequest {
    operatorSession: Session | null;
  }
}

const PUBLIC_READ_PATHS = new Set([
  "/",
  "/favicon.svg",
  "/health/live",
  "/health/ready",
  "/icon-192.svg",
  "/icon-512.svg",
  "/index.html",
  "/manifest.webmanifest",
  "/maskable-icon.svg",
  "/registerSW.js",
  "/sw.js",
]);
const HASHED_PWA_ASSET_PATH = /^\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const WORKBOX_ASSET_PATH = /^\/workbox-[A-Za-z0-9_-]+\.js$/u;

function isPublicRequest(method: string, url: string): boolean {
  if (method === "POST" && url === "/auth/login") {
    return true;
  }
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }
  return (
    PUBLIC_READ_PATHS.has(url) || HASHED_PWA_ASSET_PATH.test(url) || WORKBOX_ASSET_PATH.test(url)
  );
}

export function registerAuthentication(app: FastifyInstance, signingKey: Buffer): void {
  app.decorateRequest("operatorSession", null);
  app.addHook("onRequest", (request, reply, done) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (isPublicRequest(request.method, path)) {
      done();
      return;
    }

    const token = readSessionCookie(request.headers.cookie);
    if (token !== null) {
      try {
        request.operatorSession = verifySessionToken(token, signingKey);
        done();
        return;
      } catch {
        // Invalid, tampered, and expired tokens all share the same public response.
      }
    }
    void reply
      .header("Cache-Control", "no-store")
      .code(401)
      .send(
        ApiErrorSchema.parse({
          schemaVersion: 1,
          code: "AUTHENTICATION_REQUIRED",
          message: "Operator authentication is required",
          correlationId: request.id,
        }),
      );
  });
}
