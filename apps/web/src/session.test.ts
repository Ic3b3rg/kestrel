import { describe, expect, it } from "vitest";

import {
  CSRF_COOKIE_NAME,
  createCsrfToken,
  createSessionToken,
  readSessionCookie,
  serializeClearedAuthenticationCookies,
  serializeCsrfCookie,
  serializeSessionCookie,
  verifyCsrfToken,
  verifySessionToken,
} from "./session.js";

const signingKey = Buffer.from("f5e8bbcc7d8f6355687264a9bff1eaab", "utf8");
const operator = {
  credentialVersion: "7",
  id: "018f0f89-949a-75a8-8f61-6df78a843b1e",
  sessionGeneration: "3",
  username: "operator",
} as const;
const issuedAt = new Date("2026-08-24T12:00:00.000Z");

describe("Operator session token", () => {
  it("signs one absolute seven-day session and rejects it at expiry", () => {
    const created = createSessionToken(operator, signingKey, issuedAt);

    expect(verifySessionToken(created.token, signingKey, issuedAt)).toEqual({
      session: {
        schemaVersion: 1,
        operator: { id: operator.id, username: operator.username },
        credentialVersion: "7",
        issuedAt: "2026-08-24T12:00:00.000Z",
        expiresAt: "2026-08-31T12:00:00.000Z",
      },
      sessionGeneration: "3",
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

  it("binds a script-readable CSRF cookie to the signed session and clears both cookies", () => {
    const created = createSessionToken(operator, signingKey, issuedAt);
    const csrfToken = createCsrfToken(created.token, signingKey, Buffer.alloc(32, 9));
    const cookie = serializeCsrfCookie(csrfToken, created.session.expiresAt);

    expect(cookie).toContain(`${CSRF_COOKIE_NAME}=`);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("HttpOnly");
    expect(
      verifyCsrfToken(
        {
          cookieToken: csrfToken,
          headerToken: csrfToken,
          sessionToken: created.token,
        },
        signingKey,
      ),
    ).toBe(true);
    expect(
      verifyCsrfToken(
        {
          cookieToken: csrfToken,
          headerToken: `${csrfToken}x`,
          sessionToken: created.token,
        },
        signingKey,
      ),
    ).toBe(false);

    const cleared = serializeClearedAuthenticationCookies();
    expect(cleared).toHaveLength(2);
    for (const value of cleared) {
      expect(value).toContain("Max-Age=0");
      expect(value).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    }
  });
});
