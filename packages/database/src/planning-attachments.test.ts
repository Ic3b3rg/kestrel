import { expect, it } from "vitest";
import {
  validatePlanningAttachments,
  planningAttachmentFingerprint,
} from "./planning-attachments.js";
it("refuses binary text, mismatched image bytes and oversized Unicode text", () => {
  for (const files of [
    [{ kind: "text", name: "binary.txt", text: "a\u0000b" }],
    [{ kind: "text", name: "big.txt", text: "é".repeat(40000) }],
    [
      {
        kind: "image",
        name: "fake.png",
        mediaType: "image/png",
        data: Buffer.from("not a png").toString("base64"),
      },
    ],
  ])
    expect(() => validatePlanningAttachments(files)).toThrow();
});
it("binds retries to filenames and exact retained content", () => {
  const first = validatePlanningAttachments([{ kind: "text", name: "note.txt", text: "First" }]);
  expect(planningAttachmentFingerprint(first)).toBe(planningAttachmentFingerprint([...first]));
  expect(planningAttachmentFingerprint(first)).not.toBe(
    planningAttachmentFingerprint([{ kind: "text", name: "note.txt", text: "Changed" }]),
  );
});
