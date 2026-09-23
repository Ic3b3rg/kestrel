import { z } from "zod";
import { KestrelIdSchema } from "./v1.js";

export const SourceAuthorizationSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("cancelled") }),
  z.strictObject({
    state: z.literal("preview"),
    previewId: KestrelIdSchema,
    repositories: z
      .array(z.strictObject({ repositoryId: KestrelIdSchema, displayName: z.string().max(256) }))
      .max(100),
    skipped: z.number().int().nonnegative(),
  }),
  z.strictObject({ state: z.literal("authorized") }),
]);
export type SourceAuthorization = z.infer<typeof SourceAuthorizationSchema>;
