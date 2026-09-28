import {
  FeaturePlanDocumentSchema,
  PlanningContextSchema,
  type FeaturePlanDocument,
  type StartFactoryWorkItemCommand,
  type FactoryWorkItemStart,
} from "@kestrel/contracts";
import type { DatabasePool } from "./pool.js";
import { FactoryError, withFactoryFeature } from "./factory-planning.js";
import type { FactoryPlanArtifactRenderer } from "./factory-plans.js";

/** Dependency readiness is checked against the original plan before this projection. */
export function isolateWorkItemPlan(plan: FeaturePlanDocument, key: string): FeaturePlanDocument {
  const item = plan.workItems.find((candidate) => candidate.key === key);
  if (item === undefined) throw new FactoryError("not_found");
  return FeaturePlanDocumentSchema.parse({
    ...plan,
    objective: item.description,
    scope: { includes: [item.description], excludes: plan.scope.excludes },
    proposedDocuments: (plan.proposedDocuments ?? []).filter(
      (document) => document.workItemKey === key,
    ),
    acceptance: plan.acceptance.filter((requirement) =>
      item.requirementKeys.includes(requirement.key),
    ),
    workItems: [{ ...item, dependsOn: [], importedIssueId: null }],
  });
}

/** Publication never calls this command. Only an authenticated, explicit board action does. */
export function startFactoryWorkItem(
  pool: DatabasePool,
  projectId: string,
  featureId: string,
  workItemId: string,
  actorId: string,
  command: StartFactoryWorkItemCommand,
  render: FactoryPlanArtifactRenderer,
): Promise<FactoryWorkItemStart> {
  return withFactoryFeature(pool, projectId, featureId, async (client, feature) => {
    const existing = await client.query<{
      work_item_id: string;
      execution_feature_id: string;
      plan_version: number;
    }>("SELECT * FROM factory_work_item_starts WHERE work_item_id = $1", [workItemId]);
    const receipt = existing.rows[0];
    if (receipt !== undefined) {
      if (receipt.plan_version !== command.expectedVersion) throw new FactoryError("conflict");
      return {
        workItemId,
        executionFeatureId: receipt.execution_feature_id,
        approvedVersion: receipt.plan_version,
      };
    }
    if (
      feature.execution_mode !== "individual" ||
      feature.state === "cancelled" ||
      feature.approved_plan_version !== command.expectedVersion
    )
      throw new FactoryError("conflict", "Refresh the board before starting this issue.");
    const duplicate = await client.query(
      "SELECT 1 FROM factory_work_item_starts WHERE operator_id = $1 AND request_id = $2",
      [actorId, command.requestId],
    );
    if (duplicate.rowCount !== 0)
      throw new FactoryError("conflict", "This start request belongs to another issue.");
    const publication = await client.query(
      "SELECT 1 FROM factory_feature_publications WHERE feature_id = $1 AND state = 'published'",
      [featureId],
    );
    if (publication.rowCount !== 1)
      throw new FactoryError("conflict", "Issue publication must finish before it can start.");
    const version = command.expectedVersion;
    const retained = await client.query<{ document: unknown; source_context: unknown }>(
      "SELECT document, source_context FROM factory_plan_versions WHERE feature_id = $1 AND version = $2",
      [featureId, version],
    );
    const original = retained.rows[0];
    if (original === undefined) throw new FactoryError("not_found");
    const plan = FeaturePlanDocumentSchema.parse(original.document);
    const items = await client.query<{
      id: string;
      key: string;
      board_column: string;
      issue: unknown;
      published_at: Date | null;
    }>(
      `SELECT item.id, item.key, COALESCE(execution.board_column, item.board_column) AS board_column,
        publication.issue, publication.published_at
       FROM factory_work_items item
       LEFT JOIN factory_issue_publications publication ON publication.work_item_id = item.id
       LEFT JOIN factory_work_item_starts start ON start.work_item_id = item.id
       LEFT JOIN factory_work_items execution ON execution.id = start.execution_work_item_id
       WHERE item.feature_id = $1 AND item.plan_version = $2`,
      [featureId, version],
    );
    const item = items.rows.find((candidate) => candidate.id === workItemId);
    const definition = plan.workItems.find((candidate) => candidate.key === item?.key);
    if (item === undefined || definition === undefined) throw new FactoryError("not_found");
    if (item.published_at === null || item.issue === null || item.board_column !== "todo")
      throw new FactoryError("conflict", "Issue publication must finish before it can start.");
    const blocked = definition.dependsOn.filter(
      (key) =>
        !items.rows.some(
          (candidate) => candidate.key === key && candidate.board_column === "completed",
        ),
    );
    if (blocked.length > 0)
      throw new FactoryError(
        "conflict",
        `Complete and merge these dependencies first: ${blocked.join(", ")}`,
      );
    const identities = await client.query<{ feature_id: string; item_id: string }>(
      "SELECT uuidv7() AS feature_id, uuidv7() AS item_id",
    );
    const executionFeatureId = identities.rows[0]?.feature_id;
    const executionWorkItemId = identities.rows[0]?.item_id;
    if (executionFeatureId === undefined || executionWorkItemId === undefined)
      throw new Error("Execution identities were not allocated");
    const isolated = isolateWorkItemPlan(plan, item.key);
    const context =
      original.source_context === null
        ? null
        : PlanningContextSchema.parse(original.source_context);
    const artifacts = render({ title: definition.title, version: 1, plan: isolated, context });
    await client.query(
      `INSERT INTO factory_features (id, project_id, created_by, request_id, title, initial_title, state, latest_plan_version, approved_plan_version, execution_mode)
       VALUES ($1,$2,$3,$4,$5,$5,'queued',1,1,'authorized')`,
      [executionFeatureId, feature.project_id, actorId, command.requestId, definition.title],
    );
    await client.query(
      `INSERT INTO factory_plan_versions (feature_id, version, request_id, document, source_context, plan_markdown, spec_markdown, author, created_by)
       VALUES ($1,1,$2,$3::jsonb,$4::jsonb,$5,$6,'operator',$7)`,
      [
        executionFeatureId,
        command.requestId,
        JSON.stringify(isolated),
        JSON.stringify(context),
        artifacts.planMarkdown,
        artifacts.specMarkdown,
        actorId,
      ],
    );
    await client.query(
      `INSERT INTO factory_plan_approvals (feature_id, plan_version, request_id, operator_id, lifecycle_profile)
       SELECT $1,1,$2,$3,lifecycle_profile FROM factory_plan_approvals WHERE feature_id = $4 AND plan_version = $5`,
      [executionFeatureId, command.requestId, actorId, featureId, version],
    );
    await client.query(
      "INSERT INTO factory_work_items (id, feature_id, plan_version, key, position) VALUES ($1,$2,1,$3,1)",
      [executionWorkItemId, executionFeatureId, item.key],
    );
    // Reuse the confirmed issue identity; this lifecycle must never republish the issue.
    await client.query(
      `INSERT INTO factory_feature_publications (feature_id, state, identity, coordinates, feature_url)
       SELECT $1,'published',identity,coordinates,feature_url FROM factory_feature_publications WHERE feature_id = $2 AND state = 'published'`,
      [executionFeatureId, featureId],
    );
    await client.query(
      `INSERT INTO factory_issue_publications (work_item_id, feature_id, issue, published_at, dependency_mode)
       VALUES ($1,$2,$3::jsonb,$4,'textual')`,
      [executionWorkItemId, executionFeatureId, JSON.stringify(item.issue), item.published_at],
    );
    await client.query(
      `INSERT INTO factory_work_item_starts (work_item_id, feature_id, plan_version, execution_feature_id, execution_work_item_id, request_id, operator_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        workItemId,
        featureId,
        version,
        executionFeatureId,
        executionWorkItemId,
        command.requestId,
        actorId,
      ],
    );
    await client.query(
      "INSERT INTO factory_activity (feature_id, work_item_id, kind, summary) VALUES ($1,$2,'execution_queued',$3)",
      [featureId, workItemId, `Start requested for ${item.key}; waiting for capacity.`],
    );
    return { workItemId, executionFeatureId, approvedVersion: version };
  });
}
