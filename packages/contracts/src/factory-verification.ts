import { z } from "zod";
import { FactoryVerificationCommandSchema, type FeaturePlanDocument } from "./factory-plan.js";
import { GitObjectIdSchema, KestrelIdSchema } from "./v1.js";

export const FactoryExecutionRevisionSchema = z.strictObject({
  baseCommitId: GitObjectIdSchema,
  headCommitId: GitObjectIdSchema,
  treeId: GitObjectIdSchema,
  branch: z.string().min(1).max(200),
});
export type FactoryExecutionRevision = z.infer<typeof FactoryExecutionRevisionSchema>;

export const FactoryVerificationManifestSchema = z
  .array(
    z.strictObject({
      position: z.int().min(1).max(480),
      command: FactoryVerificationCommandSchema,
      origins: z
        .array(
          z.strictObject({
            workItemKey: z.string().min(1).max(48),
            position: z.int().min(1).max(12),
          }),
        )
        .min(1)
        .max(480),
    }),
  )
  .min(1)
  .max(480);
export type FactoryVerificationManifest = z.infer<typeof FactoryVerificationManifestSchema>;

/** Stable approved order; only the complete executable tuple can share evidence. */
export function factoryVerificationManifest(
  plan: FeaturePlanDocument,
): FactoryVerificationManifest {
  const manifest: FactoryVerificationManifest = [];
  const entries = new Map<string, FactoryVerificationManifest[number]>();
  for (const item of plan.workItems) {
    for (const [index, command] of item.verification.entries()) {
      const identity = JSON.stringify([
        command.program,
        command.args,
        command.cwd,
        command.timeoutSeconds,
      ]);
      let entry = entries.get(identity);
      if (entry === undefined) {
        entry = { position: manifest.length + 1, command, origins: [] };
        entries.set(identity, entry);
        manifest.push(entry);
      }
      entry.origins.push({ workItemKey: item.key, position: index + 1 });
    }
  }
  return FactoryVerificationManifestSchema.parse(manifest);
}

export const FactoryFeatureVerificationSchema = z.strictObject({
  id: KestrelIdSchema,
  featureId: KestrelIdSchema,
  approvedVersion: z.int().min(1).max(200),
  runId: KestrelIdSchema,
  source: z.strictObject({
    repositoryId: z.string().min(1).max(128),
    identity: z.string().min(1).max(512),
  }),
  revision: FactoryExecutionRevisionSchema,
  manifest: FactoryVerificationManifestSchema,
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  evidenceIds: z.array(KestrelIdSchema).min(1).max(480),
  createdAt: z.iso.datetime(),
});
export type FactoryFeatureVerification = z.infer<typeof FactoryFeatureVerificationSchema>;

export const FactoryAcceptedVerificationCommandsSchema = z
  .array(FactoryVerificationCommandSchema)
  .min(1)
  .max(480);
