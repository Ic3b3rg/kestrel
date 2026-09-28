import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { FactoryWorkItemStartSchema } from "@kestrel/contracts";
import {
  createFeaturePublicationJourney,
  processPublicationFixture,
} from "./support/factory-feature-publication-journey.js";
import {
  processVerificationFixture,
  verificationPlan,
} from "./support/factory-verification-fixture.js";

it("certifies and opens the selected issue's PR and review while its sibling has never started", async () => {
  const journey = await createFeaturePublicationJourney();
  try {
    const plan = verificationPlan();
    plan.scope.excludes = ["Unrelated work"];
    const parentId = await journey.approve("Independent issue start", plan, "individual");
    const initial = await journey.board(parentId);
    const chosen = initial.columns.flatMap(({ items }) => items).find(({ key }) => key === "order");
    const dependent = initial.columns
      .flatMap(({ items }) => items)
      .find(({ key }) => key === "consumer");
    if (chosen === undefined || dependent === undefined)
      throw new Error("Published issues are missing");
    const start = (id: string) =>
      journey.post(`${journey.path(parentId)}/work-items/${id}/start`, {
        requestId: randomUUID(),
        expectedVersion: 1,
      });
    expect((await start(dependent.id)).status).toBe(409);
    expect((await journey.execution(parentId)).workItems.flatMap(({ runs }) => runs)).toEqual([]);
    const response = await start(chosen.id);
    expect(response.status, await response.clone().text()).toBe(200);
    const receipt = FactoryWorkItemStartSchema.parse(await response.json());
    const queued = await journey.queue(receipt.executionFeatureId);
    expect(queued).toHaveLength(1);
    const runId = queued[0];
    if (runId === undefined) throw new Error("Issue run is missing");
    expect((await processVerificationFixture(journey.stack, runId, "order")).error).toBeNull();
    const final = await journey.queue(receipt.executionFeatureId);
    expect(final).toHaveLength(1);
    if (final[0] === undefined) throw new Error("Final verification is missing");
    await journey.certify(receipt.executionFeatureId, final[0]);
    await processPublicationFixture(journey.stack, receipt.executionFeatureId);
    const publication = await journey.publication(receipt.executionFeatureId);
    expect(publication.state).toBe("published");
    expect(publication.issues.map(({ key }) => key)).toEqual(["order"]);
    expect(publication.review?.revision.state).toBe("available");
    const parent = await journey.board(parentId);
    expect(parent.columns.find(({ id }) => id === "in_review")?.items.map(({ id }) => id)).toEqual([
      chosen.id,
    ]);
    expect(parent.columns.find(({ id }) => id === "todo")?.items.map(({ id }) => id)).toEqual([
      dependent.id,
    ]);
    expect((await start(dependent.id)).status).toBe(409);
    expect((await journey.execution(parentId)).workItems.flatMap(({ runs }) => runs)).toEqual([]);
  } finally {
    await journey.close();
  }
}, 180_000);
