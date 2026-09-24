import { expect, it } from "vitest";
import { StartPlanningFeatureCommandSchema } from "./factory-start.js";
import { SendPlanningMessageCommandSchema } from "./factory.js";
const attachments = [{ kind: "text", name: "requirements.md", text: "# Search reports" }];
it("accepts retained attachment content on both planning entry points", () => {
  const command = {
    requestId: "59b1c9d6-414c-4b98-9d62-1e2e6d092004",
    text: "Use these requirements",
    attachments,
  };
  expect(StartPlanningFeatureCommandSchema.parse(command).attachments).toEqual(attachments);
  expect(SendPlanningMessageCommandSchema.parse(command).attachments).toEqual(attachments);
});
it("rejects arbitrary image URLs, unsupported media and excessive file counts", () => {
  const command = { requestId: "59b1c9d6-414c-4b98-9d62-1e2e6d092004", text: "Read this" };
  for (const attachments of [
    [
      {
        kind: "image",
        name: "remote.png",
        mediaType: "image/png",
        data: "https://example.test/image",
      },
    ],
    [{ kind: "image", name: "page.svg", mediaType: "image/svg+xml", data: "abcd" }],
    Array.from({ length: 5 }, () => ({ kind: "text", name: "note.txt", text: "Note" })),
  ])
    expect(SendPlanningMessageCommandSchema.safeParse({ ...command, attachments }).success).toBe(
      false,
    );
});
