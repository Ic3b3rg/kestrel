import { z } from "zod";
import { KestrelIdSchema } from "./v1.js";
export const PLANNING_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const PLANNING_TEXT_MAX_BYTES = 64 * 1024;
export const PLANNING_ATTACHMENT_LIMIT = 4;
export const PLANNING_BODY_LIMIT = 12 * 1024 * 1024;
const name = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\x00-\x1f\x7f/\\]+$/u);
export const PlanningAttachmentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("image"),
    name,
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    data: z
      .string()
      .min(4)
      .max(Math.ceil(PLANNING_IMAGE_MAX_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  }),
  z.strictObject({
    kind: z.literal("text"),
    name,
    text: z
      .string()
      .max(PLANNING_TEXT_MAX_BYTES)
      .regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/u),
  }),
]);
export type PlanningAttachment = z.infer<typeof PlanningAttachmentSchema>;
export const PlanningAttachmentsSchema = z
  .array(PlanningAttachmentSchema)
  .max(PLANNING_ATTACHMENT_LIMIT);
export const PlanningAttachmentSummarySchema = z.strictObject({
  id: KestrelIdSchema,
  name,
  kind: z.enum(["image", "text"]),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "text/plain"]),
  byteLength: z.int().nonnegative().max(PLANNING_IMAGE_MAX_BYTES),
});
export type PlanningAttachmentSummary = z.infer<typeof PlanningAttachmentSummarySchema>;
