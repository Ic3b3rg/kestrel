import { describe, expect, it } from "vitest";

import {
  createSessionToken,
  readSessionCookie,
  serializeSessionCookie,
  verifySessionToken,
} from "./session.js";

const signingKey = Buffer.from("f5e8bbcc7d8f6355687264a9bff1eaab", "utf8");
const operator = {
  id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
  username: "operator",
} as const;
const issuedAt = new Date("2026-08-24T12:00:00.000Z");

describe("Operator session token", () => {
  it("signs one absolute seven-day session and rejects it at expiry", () => {
    const created = createSessionToken(operator, signingKey, issuedAt);

    expect(verifySessionToken(created.token, signingKey, issuedAt)).toEqual({
      schemaVersion: 1,
      operator,
      issuedAt: "2026-08-24T12:00:00.000Z",
      expiresAt: "2026-08-31T12:00:00.000Z",
    });
    expect(() =>
      verifySessionToken(created.token, signingKey, new Date("2026-08-31T12:00:00.000Z")),
    ).toThrow();
  });

  it("uses one host-only cookie that is unavailable to browser scripts", () => {
    const created = createSessionToken(operator, signingKey, issuedAt);
    const cookie = serializeSessionCookie(created.token, created.session.expiresAt);

    expect(cookie).toContain("__Host-kestrel-session=");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=604800");
    expect(cookie).not.toContain("Domain=");
    expect(readSessionCookie(cookie)).toBe(created.token);
    expect(readSessionCookie(`${cookie}; __Host-kestrel-session=duplicate`)).toBeNull();
  });
});
