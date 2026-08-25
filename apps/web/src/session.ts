import { createHmac, timingSafeEqual } from "node:crypto";

import {
  KestrelIdSchema,
  OperatorUsernameSchema,
  SessionSchema,
  type Operator,
  type Session,
} from "@kestrel/contracts";
import { z } from "zod";

export const SESSION_COOKIE_NAME = "__Host-kestrel-session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const JwtHeaderSchema = z.strictObject({
  alg: z.literal("HS256"),
  typ: z.literal("JWT"),
});

const JwtPayloadSchema = z.strictObject({
  aud: z.literal("kestrel-pwa"),
  exp: z.number().int().nonnegative(),
  iat: z.number().int().nonnegative(),
  iss: z.literal("kestrel"),
  sub: KestrelIdSchema,
  username: OperatorUsernameSchema,
  v: z.literal(1),
});

export interface CreatedSession {
  session: Session;
  token: string;
}

export class InvalidSessionTokenError extends Error {}

export function readSessionSigningKey(environment: NodeJS.ProcessEnv = process.env): Buffer {
  const encoded = environment.SESSION_SIGNING_KEY;
  if (!encoded || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new Error("SESSION_SIGNING_KEY must be canonical base64url");
  }
  const signingKey = Buffer.from(encoded, "base64url");
  if (signingKey.toString("base64url") !== encoded || signingKey.length !== 32) {
    throw new Error("SESSION_SIGNING_KEY must encode exactly 32 bytes");
  }
  return signingKey;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJson(value: string): unknown {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new InvalidSessionTokenError("Session token contains invalid base64url");
  }
  try {
    return JSON.parse(decoded.toString("utf8")) as unknown;
  } catch {
    throw new InvalidSessionTokenError("Session token contains invalid JSON");
  }
}

function sign(value: string, signingKey: Buffer): Buffer {
  return createHmac("sha256", signingKey).update(value, "ascii").digest();
}

function sessionFromPayload(payload: z.infer<typeof JwtPayloadSchema>): Session {
  return SessionSchema.parse({
    schemaVersion: 1,
    operator: { id: payload.sub, username: payload.username },
    issuedAt: new Date(payload.iat * 1_000).toISOString(),
    expiresAt: new Date(payload.exp * 1_000).toISOString(),
  });
}

export function createSessionToken(
  operator: Operator,
  signingKey: Buffer,
  now = new Date(),
): CreatedSession {
  if (signingKey.length < 32) {
    throw new Error("Session signing key must contain at least 32 bytes");
  }
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const payload = JwtPayloadSchema.parse({
    aud: "kestrel-pwa",
    exp: issuedAt + SESSION_TTL_SECONDS,
    iat: issuedAt,
    iss: "kestrel",
    sub: operator.id,
    username: operator.username,
    v: 1,
  });
  const unsigned = `${encodeJson({ alg: "HS256", typ: "JWT" })}.${encodeJson(payload)}`;
  const token = `${unsigned}.${sign(unsigned, signingKey).toString("base64url")}`;
  return { session: sessionFromPayload(payload), token };
}

export function verifySessionToken(token: string, signingKey: Buffer, now = new Date()): Session {
  if (signingKey.length < 32 || token.length > 4_096) {
    throw new InvalidSessionTokenError("Session token is invalid");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new InvalidSessionTokenError("Session token has an invalid shape");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) {
    throw new InvalidSessionTokenError("Session token has an invalid shape");
  }

  const actualSignature = Buffer.from(encodedSignature, "base64url");
  if (actualSignature.toString("base64url") !== encodedSignature) {
    throw new InvalidSessionTokenError("Session token contains an invalid signature");
  }
  const expectedSignature = sign(`${encodedHeader}.${encodedPayload}`, signingKey);
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new InvalidSessionTokenError("Session token signature does not match");
  }

  const header = JwtHeaderSchema.safeParse(decodeJson(encodedHeader));
  const payload = JwtPayloadSchema.safeParse(decodeJson(encodedPayload));
  if (!header.success || !payload.success) {
    throw new InvalidSessionTokenError("Session token claims are invalid");
  }
  const nowEpochSeconds = Math.floor(now.getTime() / 1_000);
  if (
    payload.data.iat > nowEpochSeconds ||
    payload.data.exp <= nowEpochSeconds ||
    payload.data.exp - payload.data.iat !== SESSION_TTL_SECONDS
  ) {
    throw new InvalidSessionTokenError("Session token is outside its validity period");
  }
  return sessionFromPayload(payload.data);
}

export function serializeSessionCookie(token: string, expiresAt: string): string {
  const expires = new Date(expiresAt);
  if (Number.isNaN(expires.getTime())) {
    throw new Error("Session expiry must be a valid date");
  }
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${String(SESSION_TTL_SECONDS)}`,
    `Expires=${expires.toUTCString()}`,
  ].join("; ");
}

export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (cookieHeader === undefined || cookieHeader.length > 8_192) {
    return null;
  }
  const prefix = `${SESSION_COOKIE_NAME}=`;
  const matches = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix));
  if (matches.length !== 1) {
    return null;
  }
  const token = matches[0]?.slice(prefix.length);
  return token && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token) ? token : null;
}
