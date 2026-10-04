import {
  FeaturePlanDocumentSchema,
  PlanningContextSchema,
  type FeaturePlanDocument,
  type PlanningContext,
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
    objective: item.title,
    scope: { includes: [item.title], excludes: plan.scope.excludes },
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
  readContext: (
    source: { repositoryId: string; identity: string },
    requiredCommits: readonly string[],
  ) => Promise<PlanningContext>,
): Promise<FactoryWorkItemStart> {
  return withFactoryFeature(pool, projectId, featureId, async (client, feature) => {
    const replay = await client.query<{
      work_item_id: string;
      feature_id: string;
      execution_feature_id: string;
      plan_version: number;
    }>(
      `SELECT start.* FROM factory_work_item_start_requests request
       JOIN factory_work_item_starts start USING (work_item_id,execution_feature_id)
       WHERE request.operator_id=$1 AND request.request_id=$2`,
      [actorId, command.requestId],
    );
    const receipt = replay.rows[0];
    if (receipt !== undefined) {
      if (
        receipt.work_item_id !== workItemId ||
        receipt.feature_id !== featureId ||
        receipt.plan_version !== command.expectedVersion
      )
        throw new FactoryError("conflict");
      return {
        workItemId,
        executionFeatureId: receipt.execution_feature_id,
        approvedVersion: receipt.plan_version,
      };
    }
    const existing = await client.query<{
      execution_feature_id: string;
      plan_version: number;
      state: string;
    }>(
      `SELECT start.*,execution.state FROM factory_work_item_starts start
       JOIN factory_features execution ON execution.id=start.execution_feature_id
       WHERE start.work_item_id=$1 AND start.feature_id=$2
       ORDER BY start.created_at DESC,start.execution_feature_id DESC LIMIT 1`,
      [workItemId, featureId],
    );
    const latest = existing.rows[0];
    const retainRequest = async (executionFeatureId: string) => {
      await client.query(
        `INSERT INTO factory_work_item_start_requests (operator_id,request_id,work_item_id,execution_feature_id)
        VALUES ($1,$2,$3,$4)`,
        [actorId, command.requestId, workItemId, executionFeatureId],
      );
    };
    if (latest !== undefined && latest.state !== "cancelled") {
      if (latest.plan_version !== command.expectedVersion) throw new FactoryError("conflict");
      await retainRequest(latest.execution_feature_id);
      return {
        workItemId,
        executionFeatureId: latest.execution_feature_id,
        approvedVersion: latest.plan_version,
      };
    }
    if (
      feature.execution_mode !== "individual" ||
      feature.state === "cancelled" ||
      feature.approved_plan_version !== command.expectedVersion
    )
      throw new FactoryError("conflict", "Refresh the board before starting this issue.");
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
      `SELECT item.id, item.key, CASE WHEN execution_feature.state='cancelled' THEN 'todo'
         ELSE COALESCE(execution.board_column, item.board_column) END AS board_column,
        publication.issue, publication.published_at
       FROM factory_work_items item
       LEFT JOIN factory_issue_publications publication ON publication.work_item_id = item.id
       LEFT JOIN LATERAL (SELECT * FROM factory_work_item_starts start WHERE start.work_item_id=item.id
         ORDER BY start.created_at DESC,start.execution_feature_id DESC LIMIT 1) start ON true
       LEFT JOIN factory_work_items execution ON execution.id = start.execution_work_item_id
       LEFT JOIN factory_features execution_feature ON execution_feature.id=start.execution_feature_id
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
    const sources = await client.query<{ repository_id: string; source_identity: string }>(
      `SELECT source.repository_id, source.source_identity FROM local_repository_sources source JOIN projects owner ON owner.id = source.project_id
       WHERE COALESCE(owner.canonical_project_id, owner.id) = $1 AND source.attachment_state = 'attached' ORDER BY source.project_id LIMIT 1`,
      [feature.project_id],
    );
    const attached = sources.rows[0];
    if (attached === undefined)
      throw new FactoryError(
        "conflict",
        "Attach the authorized repository before starting this issue.",
      );
    const executionSource = {
      repositoryId: attached.repository_id,
      identity: attached.source_identity,
    };
    const dependencies = await client.query<{ merge_commit_id: string }>(
      `SELECT merged.merge_commit_id FROM factory_work_items item
       JOIN LATERAL (SELECT * FROM factory_work_item_starts start WHERE start.work_item_id=item.id
         ORDER BY start.created_at DESC,start.execution_feature_id DESC LIMIT 1) start ON true
       JOIN factory_feature_merges merged ON merged.feature_id = start.execution_feature_id AND merged.state = 'completed'
       WHERE item.feature_id = $1 AND item.key = ANY($2::text[])`,
      [featureId, definition.dependsOn],
    );
    if (dependencies.rows.length !== definition.dependsOn.length)
      throw new FactoryError(
        "conflict",
        "Dependency merge evidence is unavailable. Refresh the board.",
      );
    let context: PlanningContext;
    try {
      context = PlanningContextSchema.parse(
        await readContext(
          executionSource,
          dependencies.rows.map((row) => row.merge_commit_id),
        ),
      );
    } catch {
      throw new FactoryError(
        "conflict",
        "Update the authorized repository to include merged dependencies, then retry this issue. Its committed source must be readable.",
      );
    }
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
      `INSERT INTO factory_work_item_starts (work_item_id, feature_id, plan_version, execution_feature_id, execution_work_item_id, request_id, operator_id, execution_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [
        workItemId,
        featureId,
        version,
        executionFeatureId,
        executionWorkItemId,
        command.requestId,
        actorId,
        JSON.stringify(executionSource),
      ],
    );
    await client.query(
      "INSERT INTO factory_activity (feature_id, work_item_id, kind, summary) VALUES ($1,$2,'execution_queued',$3)",
      [featureId, workItemId, `Start requested for ${item.key}; waiting for capacity.`],
    );
    await retainRequest(executionFeatureId);
    return { workItemId, executionFeatureId, approvedVersion: version };
  });
}
