import {
  FactoryFeaturePublicationSchema,
  RetryFactoryFeaturePublicationCommandSchema,
  type RetryFactoryFeaturePublicationCommand,
} from "@kestrel/contracts";
import {
  authenticatedMutationHeaders,
  featurePath,
  requireJson,
  InvalidServerResponseError,
} from "./api.js";

async function publicationResponse(response: Response, featureId: string) {
  const publication = await requireJson(
    response,
    FactoryFeaturePublicationSchema,
    "Feature pull request publication",
  );
  if (publication.featureId !== featureId)
    throw new InvalidServerResponseError("The server returned publication for a different Feature");
  return publication;
}
export async function fetchFactoryFeaturePublication(
  projectId: string,
  featureId: string,
  signal?: AbortSignal,
) {
  return publicationResponse(
    await fetch(`${featurePath(projectId, featureId)}/pull-request`, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    }),
    featureId,
  );
}
export async function retryFactoryFeaturePublication(
  projectId: string,
  featureId: string,
  command: RetryFactoryFeaturePublicationCommand,
  signal?: AbortSignal,
) {
  return publicationResponse(
    await fetch(`${featurePath(projectId, featureId)}/pull-request/retry`, {
      method: "POST",
      credentials: "same-origin",
      headers: authenticatedMutationHeaders(),
      body: JSON.stringify(RetryFactoryFeaturePublicationCommandSchema.parse(command)),
      signal: signal ?? null,
    }),
    featureId,
  );
}
