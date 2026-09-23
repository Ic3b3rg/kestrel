import { z } from "zod";
import { KestrelIdSchema } from "./v1.js";

export const SourceAuthorizationSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("cancelled") }),
  z.strictObject({
    state: z.literal("preview"),
    previewId: z.uuid(),
    repositories: z
      .array(z.strictObject({ repositoryId: KestrelIdSchema, displayName: z.string().max(256) }))
      .max(100),
    skipped: z.number().int().nonnegative(),
  }),
  z.strictObject({ state: z.literal("authorized") }),
]);
export type SourceAuthorization = z.infer<typeof SourceAuthorizationSchema>;

export const CloneSourceCommandSchema = z.strictObject({ url: z.string().trim().min(1).max(2048) });
export const ManagedSourceSchema = z.strictObject({
  repositoryId: KestrelIdSchema,
  displayName: z.string().min(1).max(256),
});
export const ManagedSourcesSchema = z.array(ManagedSourceSchema).max(100);
