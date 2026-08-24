import { describe, expect, it } from "vitest";

import type { InstallationEvent } from "@kestrel/contracts";

import { encodeSseEvent } from "./sse.js";

describe("SSE encoding", () => {
  it("writes one standard SSE record with an authoritative cursor", () => {
    const event: InstallationEvent = {
      schemaVersion: 1,
      eventId: "42",
      aggregateType: "installation",
      aggregateId: "018f0f89-8f75-7cc4-9860-3fda5f75d697",
      aggregateVersion: "7",
      eventType: "installation.diagnostic.running",
      occurredAt: "2026-08-24T12:00:00.000Z",
      correlationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
      causationId: "0c14b018-0260-4aa0-a5e9-61d212b948ce",
      locator: {
        installationId: "018f0f89-8f75-7cc4-9860-3fda5f75d697",
        diagnosticId: "018f0f89-9192-755f-aa96-f72094c734dd",
      },
    };

    expect(encodeSseEvent(event)).toBe(
      `id: 42\nevent: installation.diagnostic.running\ndata: ${JSON.stringify(event)}\n\n`,
    );
  });
});
