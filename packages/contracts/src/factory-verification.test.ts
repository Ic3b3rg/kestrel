import { expect, it } from "vitest";
import {
  factoryVerificationManifest,
  FactoryVerificationManifestSchema,
} from "./factory-verification.js";
import {
  FactoryExecutionRunSchema,
  FactoryExecutionRunSummarySchema,
} from "./factory-execution.js";
import { FactoryGateSchema } from "./factory-gates.js";
import type { FeaturePlanDocument } from "./factory-plan.js";

const command = { program: "node", args: ["--test", "check.mjs"], cwd: ".", timeoutSeconds: 10 };
const plan = (commands: (typeof command)[][]) =>
  ({
    workItems: commands.map((verification, index) => ({
      key: `W${String(index + 1)}`,
      verification,
    })),
  }) as FeaturePlanDocument;

it("deduplicates only identical executable tuples and retains every original association in approved order", () => {
  const different = [
    { ...command, args: ["--test", "other.mjs"] },
    { ...command, cwd: "package" },
    { ...command, timeoutSeconds: 11 },
    { ...command, program: "nodejs" },
  ];
  const manifest = factoryVerificationManifest(plan([[command, ...different], [command]]));
  expect(manifest).toHaveLength(5);
  expect(manifest[0]).toEqual({
    position: 1,
    command,
    origins: [
      { workItemKey: "W1", position: 1 },
      { workItemKey: "W2", position: 1 },
    ],
  });
  expect(manifest.slice(1).map((entry) => entry.command)).toEqual(different);
  expect(factoryVerificationManifest(plan([[command, ...different], [command]]))).toEqual(manifest);
});

it("supports the approved 40 by 12 maximum without increasing the Work Item command limit", () => {
  const manifest = factoryVerificationManifest(
    plan(
      Array.from({ length: 40 }, (_, item) =>
        Array.from({ length: 12 }, (_, position) => ({
          ...command,
          args: [String(item), String(position)],
        })),
      ),
    ),
  );
  expect(manifest).toHaveLength(480);
  expect(
    FactoryVerificationManifestSchema.safeParse([...manifest, { ...manifest[0], position: 481 }])
      .success,
  ).toBe(false);
  const id = "01991c36-7f90-7000-8000-000000000001";
  const createdAt = "2026-09-08T12:00:00.000Z";
  const summary = {
    id,
    attempt: 1,
    state: "verifying",
    failure: null,
    writerStopped: false,
    createdAt,
    startedAt: createdAt,
    completedAt: null,
  };
  const revision = {
    baseCommitId: "a".repeat(40),
    headCommitId: "b".repeat(40),
    treeId: "c".repeat(40),
    branch: "refs/heads/kestrel/feature/test",
  };
  const details = {
    ...summary,
    schemaVersion: 1,
    featureId: id,
    approvedVersion: 1,
    question: null,
    revision,
    runtime: null,
    activity: [],
    verification: [],
    acceptedCommands: manifest.map((entry) => entry.command),
  };
  expect(
    FactoryExecutionRunSchema.safeParse({ ...details, purpose: "work_item", workItemId: id })
      .success,
  ).toBe(false);
  expect(
    FactoryExecutionRunSchema.safeParse({
      ...details,
      purpose: "feature_verification",
      workItemId: null,
      initialRevision: revision,
      verificationManifest: manifest,
    }).success,
  ).toBe(true);
  expect(FactoryExecutionRunSummarySchema.safeParse({ ...summary, workItemId: null }).success).toBe(
    false,
  );
  expect(
    FactoryExecutionRunSummarySchema.safeParse({
      ...summary,
      purpose: "feature_verification",
      workItemId: id,
    }).success,
  ).toBe(false);
  expect(FactoryGateSchema.safeParse({ purpose: "work_item", workItemId: null }).success).toBe(
    false,
  );
});
