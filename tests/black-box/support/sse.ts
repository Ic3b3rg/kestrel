import { createParser } from "eventsource-parser";

import { InstallationEventSchema, type InstallationEvent } from "@kestrel/contracts";

export interface CollectInstallationEventsOptions {
  after?: string;
  cookie: string;
  count: number;
  lastEventId?: string;
  timeoutMs?: number;
}

export async function collectInstallationEvents(
  apiUrl: string,
  options: CollectInstallationEventsOptions,
): Promise<InstallationEvent[]> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Timed out collecting SSE events")),
    options.timeoutMs ?? 15_000,
  );
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    Cookie: options.cookie,
  };
  if (options.lastEventId !== undefined) {
    headers["Last-Event-ID"] = options.lastEventId;
  }
  const query = options.after === undefined ? "" : `?after=${encodeURIComponent(options.after)}`;

  try {
    const response = await fetch(`${apiUrl}/api/v1/events${query}`, {
      headers,
      signal: controller.signal,
    });
    if (response.status !== 200 || response.body === null) {
      throw new Error(`Expected an SSE response, received ${String(response.status)}`);
    }

    const events: InstallationEvent[] = [];
    const parser = createParser({
      maxBufferSize: 64 * 1024,
      onEvent(message) {
        const event = InstallationEventSchema.parse(JSON.parse(message.data));
        if (message.id !== event.eventId || message.event !== event.eventType) {
          throw new Error("SSE fields do not match the event envelope");
        }
        events.push(event);
      },
    });
    const decoder = new TextDecoder();
    const reader = response.body.getReader();

    while (events.length < options.count) {
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error("SSE stream ended before the expected events arrived");
      }
      parser.feed(decoder.decode(chunk.value, { stream: true }));
    }
    await reader.cancel();
    return events.slice(0, options.count);
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
