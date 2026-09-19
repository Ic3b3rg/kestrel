import {
  FactoryConceptualReviewDraftSchema,
  type FactoryConceptualReviewDraft,
  type FactoryConceptualReviewPreparation,
  type FactoryConceptualReviewSourceEvidence,
  type FactoryConceptualReviewSourceLines,
} from "@kestrel/contracts";
import { z } from "zod";

export type FactoryConceptualReviewValidationErrorCode =
  "invalid_output" | "source_unavailable" | "resource_exhausted";

export class FactoryConceptualReviewValidationError extends Error {
  constructor(public readonly code: FactoryConceptualReviewValidationErrorCode) {
    super(`Conceptual Review validation failed: ${code}`);
    this.name = "FactoryConceptualReviewValidationError";
  }
}

export interface ValidateFactoryConceptualReviewInput {
  preparation: FactoryConceptualReviewPreparation;
  draft: unknown;
  signal?: AbortSignal;
  readSource(
    evidence: FactoryConceptualReviewSourceEvidence,
  ): Promise<FactoryConceptualReviewSourceLines>;
  readChange(evidence: FactoryConceptualReviewSourceEvidence): Promise<{
    status: "added" | "modified" | "removed" | "unchanged";
    rangeChanged: boolean | null;
  }>;
}

function assertValidationActive(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Review validation interrupted");
}

function hostSummary(draft: FactoryConceptualReviewDraft): string {
  const mapped = draft.outcomes.filter(({ coverage }) => coverage === "mapped").length;
  const problems = draft.problems.length;
  return `${String(mapped)} of ${String(draft.outcomes.length)} approved outcomes map to exact retained source; ${String(problems)} ${problems === 1 ? "problem is" : "problems are"} identified.`;
}

const ModelNodeIdSchema = z.string().min(1).max(96);
const ModelTextSchema = z.string().min(1).max(4000);
const ModelLimitationsSchema = z.array(ModelTextSchema).max(20);

/**
 * Provider-facing schema. Problems use one uniform object because the Codex
 * structured-output subset does not accept JSON Schema `oneOf`. The host then
 * narrows that object into the stricter public discriminated union.
 */
export const FactoryConceptualReviewModelOutputSchema = z.strictObject({
  result: z.enum(["complete", "partial"]),
  summary: ModelTextSchema,
  outcomes: z
    .array(
      z.strictObject({
        id: ModelNodeIdSchema,
        outcomeKey: z.string().min(1).max(48),
        title: ModelTextSchema,
        coverage: z.enum(["mapped", "not_applicable", "gap", "unclear"]),
        behavioralStepIds: z.array(ModelNodeIdSchema).max(80),
        reason: ModelTextSchema,
      }),
    )
    .min(1)
    .max(40),
  behavioralSteps: z.array(
    z.strictObject({
      id: ModelNodeIdSchema,
      title: ModelTextSchema,
      description: ModelTextSchema,
      change: z.enum(["added", "modified", "removed", "context"]),
      outcomeKeys: z.array(z.string().min(1).max(48)).min(1).max(40),
      evidenceIds: z.array(ModelNodeIdSchema).min(1).max(80),
    }),
  ),
  evidence: z.array(
    z.strictObject({
      id: ModelNodeIdSchema,
      type: z.literal("source"),
      side: z.enum(["base", "head"]),
      path: z.string().min(1).max(4096),
      startLine: z.int().min(1).max(1_000_000),
      endLine: z.int().min(1).max(1_000_000),
      description: ModelTextSchema,
      sufficiency: ModelTextSchema,
      limitations: ModelLimitationsSchema,
    }),
  ),
  problems: z.array(
    z
      .strictObject({
        id: ModelNodeIdSchema,
        type: z.enum(["finding", "observation", "unverified_concern"]),
        title: ModelTextSchema,
        condition: ModelTextSchema.nullable(),
        consequence: ModelTextSchema.nullable(),
        reasoning: ModelTextSchema.nullable(),
        description: ModelTextSchema.nullable(),
        possibleConsequence: ModelTextSchema.nullable(),
        reasonUnverified: ModelTextSchema.nullable(),
        evidenceIds: z.array(ModelNodeIdSchema).max(80),
        riskLevel: z.enum(["low", "medium", "high", "critical"]).nullable(),
        sufficiency: ModelTextSchema.nullable(),
        limitations: ModelLimitationsSchema,
      })
      .superRefine((problem, context) => {
        const present = (value: string | null) => value !== null;
        const valid =
          problem.type === "finding"
            ? present(problem.condition) &&
              present(problem.consequence) &&
              present(problem.reasoning) &&
              problem.description === null &&
              problem.possibleConsequence === null &&
              problem.reasonUnverified === null &&
              problem.evidenceIds.length > 0 &&
              problem.riskLevel !== null &&
              present(problem.sufficiency)
            : problem.type === "observation"
              ? problem.condition === null &&
                problem.consequence === null &&
                problem.reasoning === null &&
                present(problem.description) &&
                problem.possibleConsequence === null &&
                problem.reasonUnverified === null &&
                problem.riskLevel === null &&
                problem.sufficiency === null
              : present(problem.condition) &&
                problem.consequence === null &&
                problem.reasoning === null &&
                problem.description === null &&
                present(problem.possibleConsequence) &&
                present(problem.reasonUnverified) &&
                problem.riskLevel === null &&
                problem.sufficiency === null;
        if (!valid)
          context.addIssue({ code: "custom", message: "Problem fields must match its type" });
      }),
  ),
  edges: z.array(
    z.strictObject({
      from: ModelNodeIdSchema,
      to: ModelNodeIdSchema,
      kind: z.enum(["implemented_by", "supported_by", "reveals"]),
    }),
  ),
  limitations: ModelLimitationsSchema,
});

export function parseFactoryConceptualReviewModelOutput(value: unknown): unknown {
  const parsed = FactoryConceptualReviewModelOutputSchema.safeParse(value);
  if (!parsed.success) throw new FactoryConceptualReviewValidationError("invalid_output");
  return {
    ...parsed.data,
    problems: parsed.data.problems.map((problem) => {
      const common = {
        id: problem.id,
        type: problem.type,
        title: problem.title,
        evidenceIds: problem.evidenceIds,
        limitations: problem.limitations,
      };
      switch (problem.type) {
        case "finding":
          return {
            ...common,
            condition: problem.condition,
            consequence: problem.consequence,
            reasoning: problem.reasoning,
            riskLevel: problem.riskLevel,
            sufficiency: problem.sufficiency,
          };
        case "observation":
          return { ...common, description: problem.description };
        case "unverified_concern":
          return {
            ...common,
            condition: problem.condition,
            possibleConsequence: problem.possibleConsequence,
            reasonUnverified: problem.reasonUnverified,
          };
      }
    }),
  };
}

/** Host-side authority boundary for model output. */
export async function validateFactoryConceptualReview(
  input: ValidateFactoryConceptualReviewInput,
): Promise<FactoryConceptualReviewDraft> {
  assertValidationActive(input.signal);
  const parsed = FactoryConceptualReviewDraftSchema.safeParse(input.draft);
  if (!parsed.success) throw new FactoryConceptualReviewValidationError("invalid_output");
  const draft = parsed.data;
  const basis = input.preparation.basis;
  if (basis === null) throw new FactoryConceptualReviewValidationError("invalid_output");
  if (
    Buffer.byteLength(JSON.stringify(draft), "utf8") >
    input.preparation.configuration.resources.maximumOutputBytes
  )
    throw new FactoryConceptualReviewValidationError("resource_exhausted");
  const nodeCount =
    draft.outcomes.length +
    draft.behavioralSteps.length +
    draft.evidence.length +
    draft.problems.length;
  if (nodeCount > input.preparation.configuration.resources.maximumGraphNodes)
    throw new FactoryConceptualReviewValidationError("resource_exhausted");
  if (draft.evidence.length > input.preparation.configuration.resources.maximumEvidenceItems)
    throw new FactoryConceptualReviewValidationError("resource_exhausted");

  const approvedKeys = basis.outcomes.map(({ key }) => key);
  const reportedKeys = draft.outcomes.map(({ outcomeKey }) => outcomeKey);
  if (
    new Set(reportedKeys).size !== reportedKeys.length ||
    approvedKeys.length !== reportedKeys.length ||
    approvedKeys.some((key) => !reportedKeys.includes(key))
  )
    throw new FactoryConceptualReviewValidationError("invalid_output");
  const approvedTitles = new Map(basis.outcomes.map(({ key, outcome }) => [key, outcome]));
  if (draft.outcomes.some(({ outcomeKey, title }) => approvedTitles.get(outcomeKey) !== title))
    throw new FactoryConceptualReviewValidationError("invalid_output");

  // The model produces source interpretation only. Check authority is a separate,
  // host-authored artifact field and this slice can therefore never publish Complete.
  if (draft.result !== "partial")
    throw new FactoryConceptualReviewValidationError("invalid_output");

  const changes = new Map<
    string,
    {
      status: "added" | "modified" | "removed" | "unchanged";
      rangeChanged: boolean | null;
    }
  >();
  for (const evidence of draft.evidence) {
    let source: FactoryConceptualReviewSourceLines;
    try {
      assertValidationActive(input.signal);
      source = await input.readSource(evidence);
    } catch {
      assertValidationActive(input.signal);
      throw new FactoryConceptualReviewValidationError("source_unavailable");
    }
    assertValidationActive(input.signal);
    if (
      source.status !== "available" ||
      source.side !== evidence.side ||
      source.path !== evidence.path ||
      source.startLine !== evidence.startLine ||
      source.endLine !== evidence.endLine
    )
      throw new FactoryConceptualReviewValidationError("source_unavailable");
    try {
      assertValidationActive(input.signal);
      const change = await input.readChange(evidence);
      if (change.rangeChanged === null)
        throw new FactoryConceptualReviewValidationError("resource_exhausted");
      changes.set(evidence.id, change);
    } catch (error) {
      assertValidationActive(input.signal);
      if (error instanceof FactoryConceptualReviewValidationError) throw error;
      throw new FactoryConceptualReviewValidationError("source_unavailable");
    }
    assertValidationActive(input.signal);
  }
  for (const step of draft.behavioralSteps) {
    if (step.change === "context") continue;
    const supportsClaimedChange = step.evidenceIds.some((evidenceId) => {
      const evidence = draft.evidence.find(({ id }) => id === evidenceId);
      const change = changes.get(evidenceId);
      return (
        evidence !== undefined &&
        change?.status === step.change &&
        change.rangeChanged &&
        ((step.change === "removed" && evidence.side === "base") ||
          (step.change !== "removed" && evidence.side === "head"))
      );
    });
    if (!supportsClaimedChange) throw new FactoryConceptualReviewValidationError("invalid_output");
  }
  return {
    ...draft,
    summary: hostSummary(draft),
  };
}
