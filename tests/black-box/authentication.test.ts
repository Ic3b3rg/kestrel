import { createHash, createHmac } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ApiErrorSchema,
  serializeCredentialChangeCommand,
  SessionSchema,
  StepUpProofSchema,
  type CredentialChangeCommand,
  type StepUpCommand,
} from "@kestrel/contracts";

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
  return fetch(`${stack.apiUrl}/auth/login`, {
    body: JSON.stringify(command),
    headers: { "Content-Type": "application/json", Origin: stack.apiUrl },
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
  const cookies = response.headers.getSetCookie().map((value) => value.split(";", 1)[0]);
  if (cookies.length === 0 || cookies.some((cookie) => !cookie)) {
    throw new Error("Login did not set a session cookie");
  }
  return cookies.join("; ");
}

function namedCookie(response: Response, name: string): string {
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .find((value) => value?.startsWith(`${name}=`));
  if (!cookie) {
    throw new Error(`Response did not set ${name}`);
  }
  return cookie;
}

function authenticatedMutationHeaders(
  loginResponse: Response,
  extra: Record<string, string> = {},
): Record<string, string> {
  const csrfCookie = namedCookie(loginResponse, "__Host-kestrel-csrf");
  return {
    "Content-Type": "application/json",
    Cookie: cookiePair(loginResponse),
    Origin: new URL(loginResponse.url).origin,
    "X-Kestrel-CSRF": csrfCookie.slice(csrfCookie.indexOf("=") + 1),
    ...extra,
  };
}

function credentialCommandDigest(command: CredentialChangeCommand): string {
  return createHash("sha256").update(serializeCredentialChangeCommand(command)).digest("hex");
}

async function requestStepUp(
  stack: RunningStack,
  loginResponse: Response,
  command: StepUpCommand,
): Promise<Response> {
  return fetch(`${stack.apiUrl}/auth/step-up`, {
    body: JSON.stringify(command),
    headers: authenticatedMutationHeaders(loginResponse),
    method: "POST",
  });
}

async function changeCredentials(
  stack: RunningStack,
  loginResponse: Response,
  command: CredentialChangeCommand,
  proof: string,
): Promise<Response> {
  return fetch(`${stack.apiUrl}/api/v1/operator/credentials`, {
    body: JSON.stringify(command),
    headers: authenticatedMutationHeaders(loginResponse, { "X-Kestrel-Step-Up": proof }),
    method: "POST",
  });
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
      TRUNCATE operator_step_up_proofs, authentication_rate_limits, installation_audit_records;
      DELETE FROM operators;
      CREATE UNIQUE INDEX IF NOT EXISTS operators_singleton ON operators ((true));
    `);
  });

  it("keeps only the documented login, health, and PWA surfaces public", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    const protectedResponses = await Promise.all([
      fetch(`${runningStack.apiUrl}/api/v1/session`),
      fetch(`${runningStack.apiUrl}/api/v1/installation`),
      fetch(`${runningStack.apiUrl}/api/v1/openapi.json`),
      fetch(`${runningStack.apiUrl}/future-product`),
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
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(ApiErrorSchema.parse(await response.json())).toMatchObject({
        code: "AUTHENTICATION_REQUIRED",
      });
    }

    const publicResponses = await Promise.all([
      fetch(`${runningStack.apiUrl}/health/live`),
      fetch(`${runningStack.apiUrl}/`),
      fetch(`${runningStack.apiUrl}/favicon.svg`),
      fetch(runningStack.pwaUrl),
    ]);
    expect(publicResponses.map((response) => response.status)).toEqual([200, 200, 200, 200]);

    const publicLogin = await login(runningStack, credentials);
    expect(publicLogin.status).toBe(401);
    expect(publicLogin.headers.get("cache-control")).toBe("no-store");
    expect(ApiErrorSchema.parse(await publicLogin.json())).toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
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

  it("requires same-origin CSRF proof and clears only the browser cookies on logout", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    await runningStack.bootstrapOperator(credentials);

    const crossOriginLogin = await fetch(`${runningStack.apiUrl}/auth/login`, {
      body: JSON.stringify(credentials),
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.invalid",
      },
      method: "POST",
    });
    expect(crossOriginLogin.status).toBe(403);
    expect(crossOriginLogin.headers.getSetCookie()).toEqual([]);

    const loginResponse = await login(runningStack, credentials);
    expect(loginResponse.status).toBe(200);
    expect(loginResponse.headers.get("cache-control")).toBe("no-store");
    expect(loginResponse.headers.get("pragma")).toBe("no-cache");
    expect(loginResponse.headers.get("expires")).toBe("0");
    const cookies = cookiePair(loginResponse);
    const sessionCookie = namedCookie(loginResponse, "__Host-kestrel-session");
    const csrfCookie = namedCookie(loginResponse, "__Host-kestrel-csrf");
    const csrfToken = csrfCookie.slice(csrfCookie.indexOf("=") + 1);

    const missingProof = await fetch(`${runningStack.apiUrl}/auth/logout`, {
      body: "{}",
      headers: { "Content-Type": "application/json", Cookie: cookies },
      method: "POST",
    });
    expect(missingProof.status).toBe(403);

    const wrongOrigin = await fetch(`${runningStack.apiUrl}/auth/logout`, {
      body: "{}",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookies,
        Origin: "https://attacker.invalid",
        "X-Kestrel-CSRF": csrfToken,
      },
      method: "POST",
    });
    expect(wrongOrigin.status).toBe(403);

    const logout = await fetch(`${runningStack.apiUrl}/auth/logout`, {
      body: "{}",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookies,
        Origin: runningStack.apiUrl,
        "X-Kestrel-CSRF": csrfToken,
      },
      method: "POST",
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.getSetCookie()).toHaveLength(2);
    for (const value of logout.headers.getSetCookie()) {
      expect(value).toContain("Max-Age=0");
    }
    await runningStack.executeSql(`
      DO $$
      BEGIN
        IF (
          SELECT count(*) FROM installation_audit_records
          WHERE event_type = 'operator.logout.succeeded' AND outcome = 'succeeded'
        ) <> 1 THEN
          RAISE EXCEPTION 'expected one successful logout audit record';
        END IF;
      END;
      $$;
    `);

    const copiedJwt = await fetch(`${runningStack.apiUrl}/api/v1/session`, {
      headers: { Cookie: sessionCookie },
    });
    expect(copiedJwt.status).toBe(200);
  });

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

  it("applies release-fixed login limits and records minimized abuse audit", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    await runningStack.bootstrapOperator(credentials);

    const denials: Response[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      denials.push(
        await login(runningStack, {
          username: credentials.username,
          password: `incorrect password attempt ${String(attempt)}`,
        }),
      );
    }
    expect(denials.map((response) => response.status)).toEqual(Array(10).fill(401));

    const limited = await login(runningStack, {
      username: credentials.username,
      password: "one incorrect password too many",
    });
    expect(limited.status).toBe(429);
    expect(ApiErrorSchema.parse(await limited.json())).toMatchObject({
      code: "RATE_LIMITED",
      message: "Operator authentication is temporarily limited",
    });
    expect(limited.headers.get("retry-after")).toMatch(/^[1-9][0-9]*$/u);

    await runningStack.executeSql(`
      DO $$
      BEGIN
        IF (
          SELECT count(*) FROM installation_audit_records
          WHERE event_type = 'operator.login.denied' AND outcome = 'denied'
        ) <> 10 THEN
          RAISE EXCEPTION 'expected ten denied login audit records';
        END IF;
        IF (
          SELECT count(*) FROM installation_audit_records
          WHERE event_type = 'operator.login.rate_limited' AND outcome = 'denied'
        ) <> 1 THEN
          RAISE EXCEPTION 'expected one rate-limited login audit record';
        END IF;
        IF EXISTS (
          SELECT 1 FROM installation_audit_records
          WHERE facts::text LIKE '%${credentials.username}%'
             OR facts::text LIKE '%incorrect password%'
             OR facts::text LIKE '%127.0.0.1%'
        ) THEN
          RAISE EXCEPTION 'authentication audit retained sensitive input';
        END IF;
      END;
      $$;
    `);
    await expect(
      runningStack.executeSql(`
        UPDATE installation_audit_records
        SET facts = '{"tampered":true}'::jsonb;
      `),
    ).rejects.toThrow(/append-only/u);
  });

  it("limits one source even when it rotates candidate usernames", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    await runningStack.bootstrapOperator(credentials);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await login(runningStack, {
        username: `candidate-${String(attempt)}`,
        password: "one invalid password",
      });
      statuses.push(response.status);
    }
    expect(statuses).toEqual(Array(50).fill(401));

    const limited = await login(runningStack, {
      username: "candidate-over-limit",
      password: "one invalid password",
    });
    expect(limited.status).toBe(429);
    expect(ApiErrorSchema.parse(await limited.json())).toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("binds a one-command step-up proof and invalidates every session on credential change", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    await runningStack.bootstrapOperator(credentials);
    const loginResponse = await login(runningStack, credentials);
    expect(loginResponse.status).toBe(200);
    const session = SessionSchema.parse(await loginResponse.clone().json());
    const command: CredentialChangeCommand = {
      expectedVersion: session.credentialVersion,
      newPassword: "a newly chosen correct horse battery staple",
      username: "operator-renamed",
    };
    const requestDigest = credentialCommandDigest(command);
    const baseStepUp: StepUpCommand = {
      action: "operator_credentials_change",
      password: credentials.password,
      requestDigest,
      targetId: session.operator.id,
    };

    const wrongTargetResponse = await requestStepUp(runningStack, loginResponse, {
      ...baseStepUp,
      targetId: "018f0f89-949a-75a8-8f61-6df78a843b1f",
    });
    const wrongTargetProof = StepUpProofSchema.parse(await wrongTargetResponse.json()).proof;
    const wrongTarget = await changeCredentials(
      runningStack,
      loginResponse,
      command,
      wrongTargetProof,
    );
    expect(wrongTarget.status).toBe(403);

    const wrongActionResponse = await requestStepUp(runningStack, loginResponse, {
      ...baseStepUp,
      action: "project_delete",
    });
    const wrongActionProof = StepUpProofSchema.parse(await wrongActionResponse.json()).proof;
    const wrongAction = await changeCredentials(
      runningStack,
      loginResponse,
      command,
      wrongActionProof,
    );
    expect(wrongAction.status).toBe(403);

    const wrongDigestResponse = await requestStepUp(runningStack, loginResponse, baseStepUp);
    const wrongDigestProof = StepUpProofSchema.parse(await wrongDigestResponse.json()).proof;
    const alteredCommand = { ...command, username: "unexpected-operator-name" };
    const wrongDigest = await changeCredentials(
      runningStack,
      loginResponse,
      alteredCommand,
      wrongDigestProof,
    );
    expect(wrongDigest.status).toBe(403);

    const expiredResponse = await requestStepUp(runningStack, loginResponse, baseStepUp);
    const expiredProof = StepUpProofSchema.parse(await expiredResponse.json());
    expect(Date.parse(expiredProof.expiresAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(expiredProof.expiresAt)).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1_000);
    const expiredDigest = createHash("sha256").update(expiredProof.proof).digest("hex");
    await runningStack.executeSql(`
      UPDATE operator_step_up_proofs
      SET issued_at = statement_timestamp() - interval '6 minutes',
          expires_at = statement_timestamp() - interval '1 minute'
      WHERE proof_digest = '${expiredDigest}';
    `);
    const expired = await changeCredentials(
      runningStack,
      loginResponse,
      command,
      expiredProof.proof,
    );
    expect(expired.status).toBe(403);

    const acceptedResponse = await requestStepUp(runningStack, loginResponse, baseStepUp);
    expect(acceptedResponse.status).toBe(200);
    const acceptedProof = StepUpProofSchema.parse(await acceptedResponse.json());
    const changed = await changeCredentials(
      runningStack,
      loginResponse,
      command,
      acceptedProof.proof,
    );
    expect(changed.status).toBe(204);
    expect(changed.headers.getSetCookie()).toHaveLength(2);

    const oldSession = await fetch(`${runningStack.apiUrl}/api/v1/session`, {
      headers: { Cookie: cookiePair(loginResponse) },
    });
    expect(oldSession.status).toBe(401);
    expect((await login(runningStack, credentials)).status).toBe(401);

    const renamedCredentials = {
      username: command.username,
      password: command.newPassword,
    };
    const newLogin = await login(runningStack, renamedCredentials);
    expect(newLogin.status).toBe(200);
    expect(SessionSchema.parse(await newLogin.clone().json())).toMatchObject({
      credentialVersion: "2",
      operator: { id: session.operator.id, username: command.username },
    });

    const replay = await changeCredentials(runningStack, newLogin, command, acceptedProof.proof);
    expect(replay.status).toBe(403);

    await runningStack.executeSql(`
      DO $$
      BEGIN
        IF (
          SELECT count(*) FROM operator_step_up_proofs
          WHERE consumed_at IS NOT NULL
        ) <> 5 THEN
          RAISE EXCEPTION 'expected every presented proof to be consumed once';
        END IF;
        IF (
          SELECT count(*) FROM installation_audit_records
          WHERE event_type = 'operator.credentials_change.succeeded'
        ) <> 1 THEN
          RAISE EXCEPTION 'expected one successful credential-change audit record';
        END IF;
        IF (
          SELECT count(*) FROM installation_audit_records
          WHERE event_type = 'operator.credentials_change.denied'
        ) <> 5 THEN
          RAISE EXCEPTION 'expected five denied credential-change audit records';
        END IF;
        IF (
          SELECT count(*) FROM installation_audit_records
          WHERE event_type = 'operator.step_up.issued'
        ) <> 5 THEN
          RAISE EXCEPTION 'expected five issued step-up audit records';
        END IF;
        IF EXISTS (
          SELECT 1 FROM installation_audit_records
          WHERE facts::text LIKE '%${credentials.password}%'
             OR facts::text LIKE '%${command.newPassword}%'
             OR facts::text LIKE '%${acceptedProof.proof}%'
        ) THEN
          RAISE EXCEPTION 'step-up audit retained authentication secrets';
        END IF;
      END;
      $$;
    `);
  });

  it("applies a release-fixed limit to failed step-up authentication", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    await runningStack.bootstrapOperator(credentials);
    const loginResponse = await login(runningStack, credentials);
    const session = SessionSchema.parse(await loginResponse.clone().json());
    const command: CredentialChangeCommand = {
      expectedVersion: session.credentialVersion,
      newPassword: "a newly chosen correct horse battery staple",
      username: credentials.username,
    };
    const stepUp: StepUpCommand = {
      action: "operator_credentials_change",
      password: "the wrong current password",
      requestDigest: credentialCommandDigest(command),
      targetId: session.operator.id,
    };

    const denials: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      denials.push((await requestStepUp(runningStack, loginResponse, stepUp)).status);
    }
    expect(denials).toEqual(Array(5).fill(403));

    const limited = await requestStepUp(runningStack, loginResponse, stepUp);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^[1-9][0-9]*$/u);
    expect(ApiErrorSchema.parse(await limited.json())).toMatchObject({ code: "RATE_LIMITED" });
    await runningStack.executeSql(`
      DO $$
      BEGIN
        IF (
          SELECT count(*) FROM installation_audit_records
          WHERE event_type = 'operator.step_up.denied' AND outcome = 'denied'
        ) <> 5 THEN
          RAISE EXCEPTION 'expected five denied step-up audit records';
        END IF;
        IF (
          SELECT count(*) FROM installation_audit_records
          WHERE event_type = 'operator.step_up.rate_limited' AND outcome = 'denied'
        ) <> 1 THEN
          RAISE EXCEPTION 'expected one rate-limited step-up audit record';
        END IF;
      END;
      $$;
    `);
  });

  it("consumes a valid step-up proof when the credential version is stale", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    await runningStack.bootstrapOperator(credentials);
    const loginResponse = await login(runningStack, credentials);
    const session = SessionSchema.parse(await loginResponse.clone().json());
    const staleCommand: CredentialChangeCommand = {
      expectedVersion: "2",
      newPassword: "a newly chosen correct horse battery staple",
      username: credentials.username,
    };
    const missingProof = await fetch(`${runningStack.apiUrl}/api/v1/operator/credentials`, {
      body: JSON.stringify(staleCommand),
      headers: authenticatedMutationHeaders(loginResponse),
      method: "POST",
    });
    expect(missingProof.status).toBe(403);

    const proofResponse = await requestStepUp(runningStack, loginResponse, {
      action: "operator_credentials_change",
      password: credentials.password,
      requestDigest: credentialCommandDigest(staleCommand),
      targetId: session.operator.id,
    });
    const proof = StepUpProofSchema.parse(await proofResponse.json()).proof;

    const conflict = await changeCredentials(runningStack, loginResponse, staleCommand, proof);
    expect(conflict.status).toBe(409);
    expect(ApiErrorSchema.parse(await conflict.json())).toMatchObject({
      code: "OPERATOR_VERSION_CONFLICT",
    });
    expect(
      (
        await fetch(`${runningStack.apiUrl}/api/v1/session`, {
          headers: { Cookie: cookiePair(loginResponse) },
        })
      ).status,
    ).toBe(200);
    expect((await changeCredentials(runningStack, loginResponse, staleCommand, proof)).status).toBe(
      403,
    );

    await runningStack.executeSql(`
      DO $$
      BEGIN
        IF (SELECT credential_version FROM operators) <> 1 THEN
          RAISE EXCEPTION 'stale command changed the Operator';
        END IF;
        IF (
          SELECT count(*) FROM operator_step_up_proofs
          WHERE consumed_at IS NOT NULL
        ) <> 1 THEN
          RAISE EXCEPTION 'stale command did not consume its proof';
        END IF;
      END;
      $$;
    `);
  });

  it("does not refresh a session and rejects expired, tampered, or duplicate cookies", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    await runningStack.bootstrapOperator(credentials);
    const loginResponse = await login(runningStack, credentials);
    const session = SessionSchema.parse(await loginResponse.json());
    const cookie = cookiePair(loginResponse);
    const sessionCookie = namedCookie(loginResponse, "__Host-kestrel-session");

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
      cv: "1",
      exp: expiredAt,
      iat: expiredAt - 7 * 24 * 60 * 60,
      iss: "kestrel",
      sg: "1",
      sub: session.operator.id,
      username: session.operator.username,
      v: 1,
    });
    const expired = await fetch(`${runningStack.apiUrl}/api/v1/installation`, {
      headers: { Cookie: `__Host-kestrel-session=${expiredToken}` },
    });
    const tampered = await fetch(`${runningStack.apiUrl}/api/v1/installation`, {
      headers: { Cookie: `${sessionCookie}x` },
    });
    const duplicate = await fetch(`${runningStack.apiUrl}/api/v1/installation`, {
      headers: { Cookie: `${sessionCookie}; ${sessionCookie}` },
    });

    expect(expired.status).toBe(401);
    expect(tampered.status).toBe(401);
    expect(duplicate.status).toBe(401);

    const shortlyExpiresAt = Math.floor(Date.now() / 1_000) + 2;
    const shortLivedToken = signSession({
      aud: "kestrel-pwa",
      cv: "1",
      exp: shortlyExpiresAt,
      iat: shortlyExpiresAt - 7 * 24 * 60 * 60,
      iss: "kestrel",
      sg: "1",
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

  it("rejects every session from an earlier signing generation", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;
    await runningStack.bootstrapOperator(credentials);
    const loginResponse = await login(runningStack, credentials);
    const cookie = cookiePair(loginResponse);

    const beforeRotation = await fetch(`${runningStack.apiUrl}/api/v1/session`, {
      headers: { Cookie: cookie },
    });
    expect(beforeRotation.status).toBe(200);

    await runningStack.executeSql(`
      UPDATE operators
      SET jwt_signing_generation = jwt_signing_generation + 1;
    `);

    const afterRotation = await fetch(`${runningStack.apiUrl}/api/v1/session`, {
      headers: { Cookie: cookie },
    });
    expect(afterRotation.status).toBe(401);
    expect(ApiErrorSchema.parse(await afterRotation.json())).toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });
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
