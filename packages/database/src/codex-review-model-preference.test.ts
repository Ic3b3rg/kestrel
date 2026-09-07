import { describe, expect, it, vi } from "vitest";

import {
  readCodexReviewModelPreference,
  selectCodexReviewModel,
} from "./codex-review-model-preference.js";

describe("Codex review model preference persistence", () => {
  it("reads an empty preference and atomically stores one safe model identity", async () => {
    const updatedAt = new Date("2026-09-07T12:00:00.000Z");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ selected_model_id: null, updated_at: null }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ selected_model_id: "gpt-5.6-sol", updated_at: updatedAt }],
      });
    const pool = { query } as never;

    await expect(readCodexReviewModelPreference(pool)).resolves.toEqual({
      schemaVersion: 1,
      route: "codex_subscription",
      selectedModelId: null,
      updatedAt: null,
    });
    await expect(selectCodexReviewModel(pool, "gpt-5.6-sol")).resolves.toEqual({
      schemaVersion: 1,
      route: "codex_subscription",
      selectedModelId: "gpt-5.6-sol",
      updatedAt: updatedAt.toISOString(),
    });
    expect(query.mock.calls[1]?.[1]).toEqual(["gpt-5.6-sol"]);
    expect(query.mock.calls[1]?.[0]).toContain("ON CONFLICT (installation_id)");
  });

  it("rejects an unsafe model identity before querying storage", async () => {
    const query = vi.fn();

    await expect(
      selectCodexReviewModel({ query } as never, "gpt-safe; rm -rf /"),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
