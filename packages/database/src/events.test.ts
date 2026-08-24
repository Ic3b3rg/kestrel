import { describe, expect, it, vi } from "vitest";

import { mapInstallationEvent, readEventReplayBatch } from "./events.js";

const eventRow = {
  aggregate_id: "018f0f89-8f75-7cc4-9860-3fda5f75d697",
  aggregate_version: "3",
  causation_id: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
  correlation_id: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
  created_at: new Date("2026-08-24T12:01:02.000Z"),
  event_type: "installation.diagnostic.succeeded" as const,
  id: "10",
  payload: {
    diagnosticId: "018f0f89-9192-755f-aa96-f72094c734dd",
    installationId: "018f0f89-8f75-7cc4-9860-3fda5f75d697",
  },
  schema_version: 1,
};

describe("Installation event replay", () => {
  it("validates retention and reads a replay batch in one database snapshot", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          ...eventRow,
          first_available_event_id: "9",
          latest_event_id: "10",
          retention_floor_event_id: "8",
        },
      ],
    });

    await expect(readEventReplayBatch({ query } as never, "9", 100)).resolves.toEqual({
      events: [
        {
          aggregateId: eventRow.aggregate_id,
          aggregateType: "installation",
          aggregateVersion: "3",
          causationId: eventRow.causation_id,
          correlationId: eventRow.correlation_id,
          eventId: "10",
          eventType: eventRow.event_type,
          locator: eventRow.payload,
          occurredAt: "2026-08-24T12:01:02.000Z",
          schemaVersion: 1,
        },
      ],
      valid: true,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects a replay cursor that fell outside the same retained snapshot", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          ...eventRow,
          first_available_event_id: "9",
          latest_event_id: "10",
          retention_floor_event_id: "8",
        },
      ],
    });

    await expect(readEventReplayBatch({ query } as never, "7", 100)).resolves.toEqual({
      firstAvailable: "9",
      valid: false,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not mistake a rolled-back identity gap for pruned history", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          ...eventRow,
          first_available_event_id: "2",
          id: "2",
          latest_event_id: "2",
          retention_floor_event_id: "0",
        },
      ],
    });

    await expect(readEventReplayBatch({ query } as never, "0", 100)).resolves.toMatchObject({
      events: [{ eventId: "2" }],
      valid: true,
    });
  });

  it("validates the schema version stored with every event", () => {
    expect(() => mapInstallationEvent({ ...eventRow, schema_version: 2 })).toThrow();
  });
});
