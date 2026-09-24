import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  PlanningAttachmentSchema,
  PlanningAttachmentsSchema,
  PlanningAttachmentSummarySchema,
  PLANNING_IMAGE_MAX_BYTES,
  PLANNING_TEXT_MAX_BYTES,
  type PlanningAttachment,
} from "@kestrel/contracts";
import type { PoolClient } from "pg";
import type { DatabasePool } from "./pool.js";
import { FactoryError, withFactoryFeature } from "./factory-planning.js";

export async function validatePlanningAttachments(input: unknown) {
  const attachments = PlanningAttachmentsSchema.parse(input ?? []);
  for (const file of attachments) {
    if (file.kind === "text") {
      if (Buffer.byteLength(file.text) > PLANNING_TEXT_MAX_BYTES)
        throw new FactoryError("conflict", "Text attachments must be at most 64 KB.");
    } else {
      const bytes = Buffer.from(file.data, "base64");
      const valid =
        file.mediaType === "image/png"
          ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
          : file.mediaType === "image/jpeg"
            ? bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")) &&
              bytes.subarray(-2).equals(Buffer.from("ffd9", "hex"))
            : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
      if (
        !valid ||
        bytes.length > PLANNING_IMAGE_MAX_BYTES ||
        bytes.toString("base64") !== file.data
      )
        throw new FactoryError(
          "conflict",
          "Choose a valid PNG, JPEG or WebP image of at most 2 MB.",
        );
      try {
        await sharp(bytes, { failOn: "warning", limitInputPixels: 16_000_000 }).stats();
      } catch {
        throw new FactoryError(
          "conflict",
          "Choose a complete PNG, JPEG or WebP image of at most 16 megapixels.",
        );
      }
    }
  }
  return attachments;
}
export function planningAttachmentFingerprint(files: PlanningAttachment[]) {
  return files.length === 0
    ? null
    : createHash("sha256").update(JSON.stringify(files)).digest("hex");
}
export async function savePlanningAttachments(
  client: PoolClient,
  featureId: string,
  messageId: string,
  files: PlanningAttachment[],
) {
  if (files.length === 0) return;
  const sizes = files.map((file) =>
    file.kind === "image" ? Buffer.byteLength(file.data, "base64") : Buffer.byteLength(file.text),
  );
  const existing = await client.query<{ count: string; bytes: string }>(
    "SELECT count(*) AS count, COALESCE(sum(byte_length), 0) AS bytes FROM factory_planning_attachments WHERE feature_id = $1",
    [featureId],
  );
  if (
    Number(existing.rows[0]?.count ?? 0) + files.length > 32 ||
    Number(existing.rows[0]?.bytes ?? 0) + sizes.reduce((a, b) => a + b, 0) > 16 * 1024 * 1024
  )
    throw new FactoryError(
      "conflict",
      "This conversation has reached its attachment limit (32 files or 16 MB). Start a new conversation to add more files.",
    );
  for (const [position, file] of files.entries())
    await client.query(
      "INSERT INTO factory_planning_attachments (feature_id, message_id, position, content, byte_length) VALUES ($1,$2,$3,$4::jsonb,$5)",
      [featureId, messageId, position, JSON.stringify(file), sizes[position]],
    );
}
export async function planningAttachmentSummaries(client: PoolClient, featureId: string) {
  const result = await client.query<{
    message_id: string;
    id: string;
    name: string;
    kind: string;
    mediaType: string;
    byteLength: number;
  }>(
    `SELECT message_id, id, content->>'name' AS name, content->>'kind' AS kind, COALESCE(content->>'mediaType', 'text/plain') AS "mediaType", byte_length AS "byteLength" FROM factory_planning_attachments WHERE feature_id = $1 ORDER BY message_id, position`,
    [featureId],
  );
  return result.rows.map(({ message_id, ...summary }) => ({
    messageId: message_id,
    summary: PlanningAttachmentSummarySchema.parse(summary),
  }));
}
export async function readPlanningAttachment(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  messageId: string,
  attachmentId: string,
) {
  return withFactoryFeature(pool, projectId, featureId, async (client) => {
    const result = await client.query<{ content: unknown }>(
      "SELECT content FROM factory_planning_attachments WHERE feature_id = $1 AND message_id = $2 AND id = $3",
      [featureId, messageId, attachmentId],
    );
    if (!result.rows[0]) throw new FactoryError("not_found");
    return PlanningAttachmentSchema.parse(result.rows[0].content);
  });
}
export async function readPlanningInputAttachments(
  pool: DatabasePool,
  featureId: string,
  messageIds: string[],
) {
  const result = await pool.query<{ content: unknown; message_id: string }>(
    "SELECT content, message_id FROM factory_planning_attachments WHERE feature_id = $1 AND message_id = ANY($2::uuid[]) ORDER BY message_id, position",
    [featureId, messageIds],
  );
  return result.rows.map((row) => ({
    messageId: row.message_id,
    file: PlanningAttachmentSchema.parse(row.content),
  }));
}
