import { expect, it } from "vitest";
import {
  FactoryFeaturePublicationSchema,
  FactoryFeaturePullRequestSchema,
  RetryFactoryFeaturePublicationCommandSchema,
} from "./factory-feature-publication.js";

const id = "01991c36-7f90-7000-8000-000000000001";
const request = {
  title: "Export reports",
  body: "Approved report export\n\n<!-- kestrel:feature-pr:operation -->",
  marker: "<!-- kestrel:feature-pr:operation -->",
  baseRef: "master",
  headRef: `kestrel/feature/${id}`,
  baseCommitId: "a".repeat(40),
  headCommitId: "b".repeat(40),
  repository: { id: "1", owner: "example", name: "reports" },
  id: "2",
  nodeId: "PR_example",
  repositoryNodeId: "R_example",
  authorNodeId: "U_example",
  number: 3,
  url: "https://github.com/example/reports/pull/3",
  state: "open",
  author: "operator",
};
const pending = {
  schemaVersion: 1,
  featureId: id,
  approvedVersion: 1,
  state: "pending",
  cancelled: false,
  failure: null,
  canRetry: false,
  updatedAt: null,
  certificate: null,
  issues: [],
  pullRequest: null,
  review: null,
};

it("does not report publication success without a certificate, PR and available exact revision", () => {
  expect(FactoryFeaturePublicationSchema.safeParse(pending).success).toBe(true);
  expect(
    FactoryFeaturePublicationSchema.safeParse({ ...pending, state: "published" }).success,
  ).toBe(false);
});

it.each([
  { url: "https://github.com/foreign/reports/pull/3" },
  { headRef: "master" },
  { headRef: "../other" },
  { body: "The persisted marker was removed" },
])("rejects a PR identity outside the frozen payload: %j", (change) => {
  expect(FactoryFeaturePullRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
});

it("retains numeric and node identities separately for canonical review families", () => {
  expect(FactoryFeaturePullRequestSchema.parse(request)).toEqual(request);
});

it("accepts browser UUID4 retry identities without accepting caller-supplied publication authority", () => {
  const command = { requestId: "c9a433e0-ad98-4d05-ad90-7b0d75ddf84b" };
  expect(RetryFactoryFeaturePublicationCommandSchema.parse(command)).toEqual(command);
  expect(
    RetryFactoryFeaturePublicationCommandSchema.safeParse({
      ...command,
      headCommitId: "b".repeat(40),
    }).success,
  ).toBe(false);
});
