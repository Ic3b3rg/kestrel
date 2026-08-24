import { createHmac } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ApiErrorSchema, SessionSchema } from "@kestrel/contracts";

import { startStack, type RunningStack } from "./support/compose.js";

const credentials = {
  username: "operator",
  password: "correct horse battery staple",
};
const sessionSigningKey = Buffer.from("authentication-black-box-key-32!", "utf8");
const encodedSessionSigningKey = sessionSigningKey.toString("base64url");

async function login(
  stack: RunningStack,
  command: { password: string; username: string },
): Promise<Response> {
  return fetch(`${stack.apiUrl}/api/v1/session`, {
    body: JSON.stringify(command),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

function signSession(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const unsigned = `${header}.${body}`;
  const signature = createHmac("sha256", sessionSigningKey)
    .update(unsigned, "ascii")
    .digest("base64url");
  return `${unsigned}.${signature}`;
}

function cookiePair(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) {
    throw new Error("Login did not set a session cookie");
  }
  return cookie;
}

async function waitForStreamEnd(response: Response, timeoutMs = 5_000): Promise<void> {
  if (response.body === null) {
    throw new Error("Event stream did not return a response body");
  }
  const reader = response.body.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        while (!(await reader.read()).done) {
          // Drain until the server enforces the absolute session expiry.
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Event stream remained open beyond session expiry")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    await reader.cancel().catch(() => undefined);
  }
}

describe("sole Operator authentication", () => {
  let stack: RunningStack | undefined;

  beforeAll(async () => {
    stack = await startStack({ sessionSigningKey: encodedSessionSigningKey });
  });

  afterAll(async () => {
    await stack?.close();
  });

  beforeEach(async () => {
    await stack?.executeSql(`
      DROP TRIGGER IF EXISTS kestrel_test_reject_operator ON operators;
      DROP FUNCTION IF EXISTS public.kestrel_test_reject_operator();
      DELETE FROM operators;
      CREATE UNIQUE INDEX IF NOT EXISTS operators_singleton ON operators ((true));
    `);
  });

  it("keeps only the documented health, contract, and PWA surfaces public", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    const protectedResponses = await Promise.all([
      fetch(`${runningStack.apiUrl}/api/v1/session`),
      fetch(`${runningStack.apiUrl}/api/v1/installation`),
      fetch(`${runningStack.apiUrl}/api/v1/events`, {
        headers: { Accept: "text/event-stream" },
      }),
      fetch(`${runningStack.apiUrl}/api/v1/installation/diagnostics`, {
        body: "{}",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    ]);

    for (const response of protectedResponses) {
      expect(response.status).toBe(401);
      expect(ApiErrorSchema.parse(await response.json())).toMatchObject({
        code: "AUTHENTICATION_REQUIRED",
      });
    }

    const publicResponses = await Promise.all([
      fetch(`${runningStack.apiUrl}/health/live`),
      fetch(`${runningStack.apiUrl}/api/v1/openapi.json`),
      fetch(runningStack.pwaUrl),
    ]);
    expect(publicResponses.map((response) => response.status)).toEqual([200, 200, 200]);
  });

  it("bootstraps once on the host and authenticates through a host-only cookie", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;

    const created = await runningStack.bootstrapOperator(credentials);
    expect(created).toContain("Operator created");
    const repeated = await runningStack.bootstrapOperator(credentials);
    expect(repeated).toContain("Operator already exists");

    const anonymous = await fetch(`${runningStack.apiUrl}/api/v1/installation`);
    expect(anonymous.status).toBe(401);
    expect(ApiErrorSchema.parse(await anonymous.json())).toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });

    const loginResponse = await login(runningStack, credentials);
    expect(loginResponse.status).toBe(200);
    expect(SessionSchema.parse(await loginResponse.json())).toMatchObject({
      operator: { username: credentials.username },
    });
    const setCookie = loginResponse.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Domain=");

    const authenticated = await fetch(`${runningStack.apiUrl}/api/v1/installation`, {
      headers: { Cookie: cookiePair(loginResponse) },
    });
    expect(authenticated.status).toBe(200);

    expect(created).not.toContain(credentials.password);
    expect(repeated).not.toContain(credentials.password);
    await runningStack.executeSql(`
      DO $$
      BEGIN
        IF (SELECT count(*) FROM operators) <> 1 THEN
          RAISE EXCEPTION 'expected exactly one Operator';
        END IF;
        IF EXISTS (
          SELECT 1 FROM operators
          WHERE password_hash NOT LIKE '$argon2id$v=19$m=19456,t=2,p=1$%'
        ) THEN
          RAISE EXCEPTION 'Operator password was not stored as the certified Argon2id profile';
        END IF;
      END;
      $$;
    `);
  }, 60_000);

  it("returns the same denial for an unknown username and a wrong password", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    await runningStack.bootstrapOperator(credentials);

    const unknown = await login(runningStack, {
      username: "someone-else",
      password: credentials.password,
    });
    const wrongPassword = await login(runningStack, {
      username: credentials.username,
      password: "this password is not correct",
    });

    expect(unknown.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(ApiErrorSchema.parse(await unknown.json())).toMatchObject({
      code: "AUTHENTICATION_FAILED",
      message: "The Operator credentials are invalid",
    });
    expect(ApiErrorSchema.parse(await wrongPassword.json())).toMatchObject({
      code: "AUTHENTICATION_FAILED",
      message: "The Operator credentials are invalid",
    });
    expect(unknown.headers.get("set-cookie")).toBeNull();
    expect(wrongPassword.headers.get("set-cookie")).toBeNull();
  });

  it("does not refresh a session and rejects expired, tampered, or duplicate cookies", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    await runningStack.bootstrapOperator(credentials);
    const loginResponse = await login(runningStack, credentials);
    const session = SessionSchema.parse(await loginResponse.json());
    const cookie = cookiePair(loginResponse);

    expect((Date.parse(session.expiresAt) - Date.parse(session.issuedAt)) / 1_000).toBe(
      7 * 24 * 60 * 60,
    );
    const currentSession = await fetch(`${runningStack.apiUrl}/api/v1/session`, {
      headers: { Cookie: cookie },
    });
    expect(currentSession.status).toBe(200);
    expect(currentSession.headers.get("set-cookie")).toBeNull();

    const expiredAt = Math.floor(Date.now() / 1_000) - 1;
    const expiredToken = signSession({
      aud: "kestrel-pwa",
      exp: expiredAt,
      iat: expiredAt - 7 * 24 * 60 * 60,
      iss: "kestrel",
      sub: session.operator.id,
      username: session.operator.username,
      v: 1,
    });
    const expired = await fetch(`${runningStack.apiUrl}/api/v1/installation`, {
      headers: { Cookie: `__Host-kestrel-session=${expiredToken}` },
    });
    const tampered = await fetch(`${runningStack.apiUrl}/api/v1/installation`, {
      headers: { Cookie: `${cookie}x` },
    });
    const duplicate = await fetch(`${runningStack.apiUrl}/api/v1/installation`, {
      headers: { Cookie: `${cookie}; ${cookie}` },
    });

    expect(expired.status).toBe(401);
    expect(tampered.status).toBe(401);
    expect(duplicate.status).toBe(401);

    const shortlyExpiresAt = Math.floor(Date.now() / 1_000) + 2;
    const shortLivedToken = signSession({
      aud: "kestrel-pwa",
      exp: shortlyExpiresAt,
      iat: shortlyExpiresAt - 7 * 24 * 60 * 60,
      iss: "kestrel",
      sub: session.operator.id,
      username: session.operator.username,
      v: 1,
    });
    const stream = await fetch(`${runningStack.apiUrl}/api/v1/events`, {
      headers: {
        Accept: "text/event-stream",
        Cookie: `__Host-kestrel-session=${shortLivedToken}`,
      },
    });
    expect(stream.status).toBe(200);
    await waitForStreamEnd(stream);
  });

  it("serializes concurrent bootstrap attempts into one Operator", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    const alternative = {
      username: "second-operator",
      password: "another correct horse battery staple",
    };

    const results = await Promise.all([
      runningStack.bootstrapOperator(credentials),
      runningStack.bootstrapOperator(alternative),
    ]);
    expect(results.filter((result) => result.includes("Operator created"))).toHaveLength(1);
    expect(results.filter((result) => result.includes("Operator already exists"))).toHaveLength(1);

    const statuses = await Promise.all([
      login(runningStack, credentials).then((response) => response.status),
      login(runningStack, alternative).then((response) => response.status),
    ]);
    expect(statuses.sort()).toEqual([200, 401]);
  });

  it("rolls back a persistence failure before a later bootstrap succeeds", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    await runningStack.executeSql(`
      CREATE FUNCTION public.kestrel_test_reject_operator()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'injected Operator persistence failure';
      END;
      $$;
      CREATE TRIGGER kestrel_test_reject_operator
      BEFORE INSERT ON operators
      FOR EACH ROW
      EXECUTE FUNCTION public.kestrel_test_reject_operator();
    `);

    await expect(runningStack.bootstrapOperator(credentials)).rejects.toThrow();
    await runningStack.executeSql(`
      DROP TRIGGER kestrel_test_reject_operator ON operators;
      DROP FUNCTION public.kestrel_test_reject_operator();
    `);
    await expect(runningStack.bootstrapOperator(credentials)).resolves.toContain(
      "Operator created",
    );
  });

  it("fails closed when the Operator lookup is ambiguous", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    await runningStack.executeSql(`
      DROP INDEX operators_singleton;
      INSERT INTO operators (username, password_hash)
      VALUES
        ('first', '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
        ('second', '$argon2id$v=19$m=19456,t=2,p=1$BBBBBBBBBBBBBBBBBBBBBB$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
    `);

    await expect(runningStack.bootstrapOperator(credentials)).rejects.toThrow();
  });
});
