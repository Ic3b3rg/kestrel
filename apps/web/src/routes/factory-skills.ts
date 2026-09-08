import { isAbsolute } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ApiErrorSchema,
  FeaturePlanningSkillsSchema,
  InstallPlanningSkillCommandSchema,
  KestrelIdSchema,
  PlanningSkillBundleSchema,
  PlanningSkillCandidatesSchema,
  PlanningSkillCatalogSchema,
  PlanningSkillDigestSchema,
  SelectPlanningSkillsCommandSchema,
} from "@kestrel/contracts";
import {
  installPlanningSkill,
  listPlanningSkills,
  readPlanningSkill,
  readPlanningSkillInstall,
  readFeaturePlanningSkills,
  saveFeaturePlanningSkills,
  type DatabasePool,
} from "@kestrel/database";
import { AUTHENTICATED_MUTATION_ROUTE_CONFIG } from "../authentication.js";
import {
  FactorySkillBundleError,
  enumerateHostSkillCandidates,
  loadHostSkillBundle,
} from "../factory-skill-bundles.js";
import { factoryError } from "./factory-planning.js";

const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7" });
const errors = {
  400: jsonSchema(ApiErrorSchema),
  401: jsonSchema(ApiErrorSchema),
  403: jsonSchema(ApiErrorSchema),
  404: jsonSchema(ApiErrorSchema),
  409: jsonSchema(ApiErrorSchema),
  413: jsonSchema(ApiErrorSchema),
  415: jsonSchema(ApiErrorSchema),
  500: jsonSchema(ApiErrorSchema),
  503: jsonSchema(ApiErrorSchema),
};
const featureParams = z.strictObject({ projectId: KestrelIdSchema, featureId: KestrelIdSchema });
const skillParams = z.strictObject({ digest: PlanningSkillDigestSchema });
function configuredRoot(): string | undefined {
  const root = process.env.KESTREL_PLANNING_SKILL_ROOT;
  if (root === undefined || root === "") return undefined;
  if (!isAbsolute(root)) throw new FactorySkillBundleError("root_unavailable");
  return root;
}
function reject(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof FactorySkillBundleError) {
    const status =
      error.code === "root_unavailable" ? 503 : error.code === "candidate_not_found" ? 404 : 400;
    return reply.code(status).send(
      ApiErrorSchema.parse({
        schemaVersion: 1,
        code:
          status === 503 ? "SERVICE_UNAVAILABLE" : status === 404 ? "NOT_FOUND" : "INVALID_REQUEST",
        message: error.message,
        correlationId: request.id,
      }),
    );
  }
  const failure = factoryError(request, error);
  return reply.code(failure.status).send(failure.body);
}
export function registerPlanningSkillRoutes(app: FastifyInstance, pool: DatabasePool): void {
  app.get(
    "/api/v1/planning-skills",
    { schema: { response: { ...errors, 200: jsonSchema(PlanningSkillCatalogSchema) } } },
    async (request, reply) => {
      try {
        return { schemaVersion: 1, skills: await listPlanningSkills(pool) };
      } catch (error) {
        return reject(request, reply, error);
      }
    },
  );
  app.get(
    "/api/v1/planning-skills/candidates",
    { schema: { response: { ...errors, 200: jsonSchema(PlanningSkillCandidatesSchema) } } },
    async (request, reply) => {
      try {
        const root = configuredRoot();
        return {
          schemaVersion: 1,
          configured: root !== undefined,
          candidates: root === undefined ? [] : await enumerateHostSkillCandidates(root),
        };
      } catch (error) {
        return reject(request, reply, error);
      }
    },
  );
  app.get(
    "/api/v1/planning-skills/:digest",
    {
      schema: {
        params: jsonSchema(skillParams),
        response: { ...errors, 200: jsonSchema(PlanningSkillBundleSchema) },
      },
    },
    async (request, reply) => {
      try {
        return await readPlanningSkill(pool, skillParams.parse(request.params).digest);
      } catch (error) {
        return reject(request, reply, error);
      }
    },
  );
  app.post(
    "/api/v1/planning-skills/install",
    {
      bodyLimit: 1024,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        body: jsonSchema(InstallPlanningSkillCommandSchema),
        response: { ...errors, 201: jsonSchema(PlanningSkillBundleSchema) },
      },
    },
    async (request, reply) => {
      try {
        const command = InstallPlanningSkillCommandSchema.parse(request.body);
        const actorId = request.operatorSession?.operator.id;
        if (actorId === undefined) throw new Error("Authenticated Skill import has no Operator");
        const existing = await readPlanningSkillInstall(pool, actorId, command);
        if (existing !== null) return await reply.code(201).send(existing);
        const root = configuredRoot();
        if (root === undefined)
          return await reply.code(503).send(
            ApiErrorSchema.parse({
              schemaVersion: 1,
              code: "SERVICE_UNAVAILABLE",
              message:
                "Set KESTREL_PLANNING_SKILL_ROOT to an authorized Skill folder when starting Kestrel, then import from this chat.",
              correlationId: request.id,
            }),
          );
        return await reply
          .code(201)
          .send(
            await installPlanningSkill(
              pool,
              actorId,
              command,
              await loadHostSkillBundle(root, command.candidateId),
            ),
          );
      } catch (error) {
        return reject(request, reply, error);
      }
    },
  );
  app.get(
    "/api/v1/projects/:projectId/features/:featureId/skills",
    {
      schema: {
        params: jsonSchema(featureParams),
        response: { ...errors, 200: jsonSchema(FeaturePlanningSkillsSchema) },
      },
    },
    async (request, reply) => {
      try {
        const { projectId, featureId } = featureParams.parse(request.params);
        return await readFeaturePlanningSkills(pool, projectId, featureId);
      } catch (error) {
        return reject(request, reply, error);
      }
    },
  );
  app.post(
    "/api/v1/projects/:projectId/features/:featureId/skills",
    {
      bodyLimit: 2048,
      config: AUTHENTICATED_MUTATION_ROUTE_CONFIG,
      schema: {
        params: jsonSchema(featureParams),
        body: jsonSchema(SelectPlanningSkillsCommandSchema),
        response: { ...errors, 200: jsonSchema(FeaturePlanningSkillsSchema) },
      },
    },
    async (request, reply) => {
      try {
        const { projectId, featureId } = featureParams.parse(request.params);
        return await saveFeaturePlanningSkills(
          pool,
          projectId,
          featureId,
          SelectPlanningSkillsCommandSchema.parse(request.body),
        );
      } catch (error) {
        return reject(request, reply, error);
      }
    },
  );
}
