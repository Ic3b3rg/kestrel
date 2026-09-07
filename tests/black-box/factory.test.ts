import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LocalRepositoryInventorySchema, ProjectUpsertedSchema } from "@kestrel/contracts";

import { startStack, type RunningStack } from "./support/compose.js";
import { createGitFixture, type GitFixture } from "./support/git-fixture.js";

describe("persistent Factory planning", () => {
  let stack: RunningStack;
  let fixture: GitFixture;
  let projectId: string;
  const cleanup: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    fixture = await createGitFixture();
    cleanup.push(() => fixture.close());
    stack = await startStack({ repositoryRoot: fixture.rootPath });
    cleanup.push(() => stack.close());
    await stack.authenticateOperator();
    const inventory = LocalRepositoryInventorySchema.parse(
      await (await stack.fetchApi("/api/v1/local-repository-sources")).json(),
    );
    const repository = inventory.repositories[0];
    if (repository === undefined) throw new Error("Fixture repository missing");
    const response = await stack.fetchApi("/api/v1/projects/local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryId: repository.repositoryId }),
    });
    projectId = ProjectUpsertedSchema.parse(await response.json()).project.id;
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
});
