import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ApiErrorSchema,
  LocalRepositoryInventorySchema,
  ProjectUpsertedSchema,
} from "@kestrel/contracts";

import { startStack, type RunningStack } from "./support/compose.js";
import { createGitFixture, type GitFixture } from "./support/git-fixture.js";

describe("persistent Factory planning", () => {
  let stack: RunningStack;
  let fixture: GitFixture;
  let projectId: string;
  let otherProjectId: string;
  const cleanup: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    fixture = await createGitFixture();
    cleanup.push(() => fixture.close());
    await fixture.createSibling("factory-other");
    stack = await startStack({ repositoryRoot: fixture.rootPath });
    cleanup.push(() => stack.close());
    await stack.authenticateOperator();
    const inventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const repository = inventory.repositories.find(({ displayName }) => displayName === "kestrel");
    if (repository === undefined) throw new Error("Fixture repository missing");
    const response = await stack.fetchApi("/api/v1/projects/local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryId: repository.repositoryId }),
    });
    projectId = ProjectUpsertedSchema.parse(await response.json()).project.id;
    const other = inventory.repositories.find(({ displayName }) => displayName === "factory-other");
    if (other === undefined) throw new Error("Other fixture repository missing");
    const otherResponse = await stack.fetchApi("/api/v1/projects/local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryId: other.repositoryId }),
    });
    otherProjectId = ProjectUpsertedSchema.parse(await otherResponse.json()).project.id;
  });

  afterAll(async () => {
    for (const close of cleanup.toReversed()) await close();
  });

  it("creates an idempotent feature chat and reloads it from the Project", async () => {
    const requestId = randomUUID();
    const command = { requestId, title: "Explain the export before implementation" };
    const create = () =>
      stack.fetchApi(`/api/v1/projects/${projectId}/features`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
    const response = await create();
    expect(response.status, await response.clone().text()).toBe(201);
    const feature = (await response.json()) as { id: string; title: string; projectId: string };
    expect(feature).toMatchObject({ title: command.title, projectId });
    const retry = await create();
    expect(await retry.json()).toEqual(feature);
    const saved = await stack.fetchApi(`/api/v1/projects/${projectId}/features/${feature.id}`);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ feature, messages: [] });
    const list = await stack.fetchApi(`/api/v1/projects/${projectId}/features`);
    expect(await list.json()).toMatchObject({ features: [feature] });
  });

  it("accepts a message durably once even when the browser repeats the send", async () => {
    const created = await stack.fetchApi(`/api/v1/projects/${projectId}/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: randomUUID(), title: "Preserve filter behavior" }),
    });
    const feature = (await created.json()) as { id: string };
    const url = `/api/v1/projects/${projectId}/features/${feature.id}`;
    const command = {
      requestId: randomUUID(),
      text: "Which export decisions are still unresolved?",
    };
    const send = () =>
      stack.fetchApi(`${url}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
    const [first, repeated] = await Promise.all([send(), send()]);
    expect(first.status, await first.clone().text()).toBe(202);
    expect(repeated.status, await repeated.clone().text()).toBe(202);
    const original = (await first.json()) as { turnId: string };
    expect(await repeated.json()).toEqual(original);
    await stack.restart("web");
    const conversation = (await (await stack.fetchApi(url)).json()) as {
      messages: Array<{ role: string; content: string }>;
      turns: Array<{ id: string; state: string }>;
    };
    expect(conversation.messages).toEqual([
      expect.objectContaining({ role: "user", content: command.text }),
    ]);
    expect(conversation.turns).toEqual([expect.objectContaining({ id: original.turnId })]);
  });

  it("reports an unavailable runtime after accepting work without inventing an assistant answer", async () => {
    const created = await stack.fetchApi(`/api/v1/projects/${projectId}/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: randomUUID(), title: "Plan with explicit runtime status" }),
    });
    const feature = (await created.json()) as { id: string };
    const url = `/api/v1/projects/${projectId}/features/${feature.id}`;
    const accepted = await stack.fetchApi(`${url}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: randomUUID(), text: "Help clarify the export behavior." }),
    });
    expect(accepted.status).toBe(202);
    await expect
      .poll(
        async () => {
          const chat = (await (await stack.fetchApi(url)).json()) as {
            turns: Array<{ state: string; failure: string }>;
          };
          return chat.turns[0];
        },
        { timeout: 10_000, interval: 200 },
      )
      .toMatchObject({ state: "failed", failure: "unavailable" });
    const chat = (await (await stack.fetchApi(url)).json()) as {
      messages: Array<{ role: string }>;
      context: { notice: string };
      turns: Array<{ id: string }>;
    };
    expect(chat.messages.map(({ role }) => role)).toEqual(["user"]);
    expect(chat.context.notice).toContain("No committed");
    const originalId = chat.turns[0]?.id;
    if (originalId === undefined) throw new Error("The failed turn is unavailable");
    const requestId = randomUUID();
    const retry = () =>
      stack.fetchApi(`${url}/turns/${originalId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
    const retried = await retry();
    expect(retried.status, await retried.clone().text()).toBe(202);
    const retryResult = (await retried.json()) as { turnId: string };
    expect(await (await retry()).json()).toEqual(retryResult);
    expect(retryResult.turnId).not.toBe(originalId);
    const stopped = await stack.fetchApi(`${url}/turns/${retryResult.turnId}/cancel`, {
      method: "POST",
    });
    expect(stopped.status, await stopped.clone().text()).toBe(200);
    const finalChat = (await stopped.json()) as {
      messages: unknown[];
      turns: Array<{ state: string }>;
    };
    expect(finalChat.messages).toHaveLength(1);
    expect(finalChat.turns).toHaveLength(2);
    expect(["cancelled", "failed"]).toContain(finalChat.turns[1]?.state);
  });

  it("rejects unauthenticated, cross-origin, changed duplicate, and cross-Project commands", async () => {
    const path = `/api/v1/projects/${projectId}/features`;
    const command = { requestId: randomUUID(), title: "Keep conversations in their Project" };
    expect((await fetch(new URL(path, stack.apiUrl))).status).toBe(401);
    const untrusted = await fetch(new URL(path, stack.apiUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: stack.sessionCookie,
        Origin: "https://untrusted.invalid",
      },
      body: JSON.stringify(command),
    });
    expect(untrusted.status).toBe(403);
    const post = (url: string, body: unknown) =>
      stack.fetchApi(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const created = await post(path, command);
    expect(created.status).toBe(201);
    const feature = (await created.json()) as { id: string };
    expect((await post(path, { ...command, title: "Changed request" })).status).toBe(409);
    expect((await post(`/api/v1/projects/${otherProjectId}/features`, command)).status).toBe(409);
    const chatPath = `${path}/${feature.id}`;
    const wrongPath = `/api/v1/projects/${otherProjectId}/features/${feature.id}`;
    expect((await stack.fetchApi(wrongPath)).status).toBe(404);
    const message = { requestId: randomUUID(), text: "Clarify the acceptance criteria." };
    expect((await post(`${wrongPath}/messages`, message)).status).toBe(404);
    const accepted = await post(`${chatPath}/messages`, message);
    expect(accepted.status).toBe(202);
    const turn = (await accepted.json()) as { turnId: string };
    expect(
      (await post(`${chatPath}/messages`, { ...message, text: "Changed message" })).status,
    ).toBe(409);
    expect(
      (await stack.fetchApi(`${wrongPath}/turns/${turn.turnId}/cancel`, { method: "POST" })).status,
    ).toBe(404);
    expect(
      (await post(`${wrongPath}/turns/${turn.turnId}/retry`, { requestId: randomUUID() })).status,
    ).toBe(404);
    const saved = (await (await stack.fetchApi(chatPath)).json()) as { messages: unknown[] };
    expect(saved.messages).toHaveLength(1);
  });

  it("makes an expired uncertain turn retryable without retaining its uncertain runtime thread", async () => {
    const path = `/api/v1/projects/${projectId}/features`;
    const created = await stack.fetchApi(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: randomUUID(), title: "Recover interrupted planning" }),
    });
    const feature = (await created.json()) as { id: string };
    const chatPath = `${path}/${feature.id}`;
    const accepted = await stack.fetchApi(`${chatPath}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: randomUUID(),
        text: "What should happen after an interruption?",
      }),
    });
    const turn = (await accepted.json()) as { turnId: string };
    await expect
      .poll(
        async () => {
          const chat = (await (await stack.fetchApi(chatPath)).json()) as {
            turns: Array<{ state: string }>;
          };
          return chat.turns[0]?.state;
        },
        { timeout: 10_000, interval: 200 },
      )
      .toBe("failed");
    // Reproduce a host crash after thread creation, before the result can be persisted.
    await stack.executeSql(`
      UPDATE factory_features SET runtime_thread_id = 'uncertain-thread' WHERE id = '${feature.id}';
      UPDATE factory_planning_turns SET state = 'running', failure = NULL, completed_at = NULL,
        started_at = clock_timestamp() - interval '5 minutes' WHERE id = '${turn.turnId}';
    `);
    const chat = (await (await stack.fetchApi(chatPath)).json()) as {
      turns: unknown[];
      messages: unknown[];
    };
    expect(chat.turns).toEqual([
      expect.objectContaining({ id: turn.turnId, state: "failed", failure: "interrupted" }),
    ]);
    expect(chat.messages).toHaveLength(1);
    const threadCleared = await stack.executeWebModule(`
      import { createPool } from "@kestrel/database";
      const pool = createPool(process.env.DATABASE_URL);
      try {
        const result = await pool.query("SELECT runtime_thread_id IS NULL AS cleared FROM factory_features WHERE id = $1", ["${feature.id}"]);
        process.stdout.write(JSON.stringify(result.rows[0].cleared));
      } finally { await pool.end(); }
    `);
    expect(JSON.parse(threadCleared)).toBe(true);
  });

  it("rejects a retry when its answer could no longer be retrieved", async () => {
    const created = await stack.fetchApi(`/api/v1/projects/${projectId}/features`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: randomUUID(),
        title: "Keep every accepted answer visible",
      }),
    });
    const feature = (await created.json()) as { id: string };
    const chatPath = `/api/v1/projects/${projectId}/features/${feature.id}`;
    const accepted = await stack.fetchApi(`${chatPath}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: randomUUID(), text: "Clarify one remaining question." }),
    });
    const turn = (await accepted.json()) as { turnId: string };
    await expect
      .poll(
        async () => {
          const chat = (await (await stack.fetchApi(chatPath)).json()) as {
            turns: Array<{ state: string }>;
          };
          return chat.turns[0]?.state;
        },
        { timeout: 10_000, interval: 200 },
      )
      .toBe("failed");
    await stack.executeSql(`
      INSERT INTO factory_planning_messages (feature_id, role, content)
        SELECT '${feature.id}', 'user', 'Earlier decision ' || number FROM generate_series(2, 199) AS number;
      INSERT INTO factory_planning_messages (feature_id, role, content, reply_to_turn_id)
        VALUES ('${feature.id}', 'assistant', 'Which option should be retained?', '${turn.turnId}');
      UPDATE factory_planning_turns SET failure = 'input_required' WHERE id = '${turn.turnId}';
    `);
    const retry = await stack.fetchApi(`${chatPath}/turns/${turn.turnId}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: randomUUID() }),
    });
    expect(retry.status, await retry.clone().text()).toBe(409);
    expect(ApiErrorSchema.parse(await retry.json()).message).toContain("conversation limit");
    const saved = (await (await stack.fetchApi(chatPath)).json()) as {
      messages: unknown[];
      turns: unknown[];
    };
    expect(saved.messages).toHaveLength(200);
    expect(saved.turns).toHaveLength(1);
  });

  it("keeps feature creation within the inventory it can reopen, including duplicate requests at capacity", async () => {
    const path = `/api/v1/projects/${otherProjectId}/features`;
    const command = { requestId: randomUUID(), title: "Last available feature" };
    const create = (body: unknown) =>
      stack.fetchApi(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const first = await create(command);
    expect(first.status).toBe(201);
    const feature = (await first.json()) as { id: string };
    await stack.executeSql(`
      INSERT INTO factory_features (project_id, created_by, request_id, title)
        SELECT project_id, created_by, uuidv7(), 'Earlier feature ' || number
        FROM factory_features CROSS JOIN generate_series(1, 199) AS number WHERE id = '${feature.id}';
    `);
    const duplicate = await create(command);
    expect(duplicate.status).toBe(201);
    expect(await duplicate.json()).toEqual(feature);
    const overflow = await create({ requestId: randomUUID(), title: "An unreachable feature" });
    expect(overflow.status, await overflow.clone().text()).toBe(409);
    expect(ApiErrorSchema.parse(await overflow.json()).message).toContain("feature limit");
    const list = (await (await stack.fetchApi(path)).json()) as { features: unknown[] };
    expect(list.features).toHaveLength(200);
  });
});
