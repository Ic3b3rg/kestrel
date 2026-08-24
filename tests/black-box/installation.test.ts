import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startStack, type RunningStack } from "./support/compose.js";

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return response.json();
}

describe("observable Kestrel Installation", () => {
  let stack: RunningStack | undefined;

  beforeAll(async () => {
    stack = await startStack();
  });

  afterAll(async () => {
    await stack?.close();
  });

  it("exposes the same persisted Installation across a web restart", async () => {
    expect(stack).toBeDefined();
    const runningStack = stack as RunningStack;

    const before = await getJson(`${runningStack.apiUrl}/api/v1/installation`);
    await runningStack.restart("web");
    const after = await getJson(`${runningStack.apiUrl}/api/v1/installation`);

    expect(after).toEqual(before);
  }, 60_000);
});
