import { afterEach, expect, it, vi } from "vitest";
import { ApiClientError, InvalidServerResponseError } from "./api.js";
import { fetchFactoryExecution, fetchFactoryExecutionRun } from "./factory-execution-api.js";

const projectId = "018f0f89-949a-75a8-8f61-6df78a843b1e";
const featureId = "018f0f89-9192-755f-aa96-f72094c734df";

afterEach(() => vi.unstubAllGlobals());

it("rejects an execution read for another feature instead of showing its work", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        schemaVersion: 1,
        featureId: projectId,
        state: "pending",
        failure: null,
        question: null,
        revision: null,
        workItems: [],
      }),
    ),
  );
  await expect(fetchFactoryExecution(projectId, featureId)).rejects.toBeInstanceOf(
    InvalidServerResponseError,
  );
});

it("preserves the authenticated read boundary and abort signal for attempt details", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json(
      {
        schemaVersion: 1,
        code: "AUTHENTICATION_REQUIRED",
        message: "Sign in to continue",
        correlationId: projectId,
      },
      { status: 401 },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  await expect(
    fetchFactoryExecutionRun(projectId, featureId, projectId, controller.signal),
  ).rejects.toBeInstanceOf(ApiClientError);
  expect(fetch).toHaveBeenCalledWith(
    `/api/v1/projects/${projectId}/features/${featureId}/execution/runs/${projectId}`,
    expect.objectContaining({
      method: "GET",
      credentials: "same-origin",
      signal: controller.signal,
    }),
  );
});
