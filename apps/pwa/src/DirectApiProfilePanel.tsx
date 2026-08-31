import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { ConfigureDirectApiProfileCommandSchema, type DirectApiProfile } from "@kestrel/contracts";

import {
  ApiClientError,
  configureDirectApiProfile,
  fetchDirectApiProfile,
  testDirectApiProfile,
} from "./api.js";

const availabilityLabels: Record<DirectApiProfile["availability"], string> = {
  available: "Available",
  stale: "Stale",
  unavailable: "Unavailable",
};

const reasonLabels: Record<DirectApiProfile["availabilityReasons"][number], string> = {
  attestation_expired: "Data-policy attestation expired",
  credential_unavailable: "Stored credential unavailable",
  identity_drift: "Observed provider identity drifted",
  provider_unavailable: "Provider unavailable",
  synthetic_test_expired: "Synthetic profile test expired",
  synthetic_test_failed: "Synthetic profile test failed",
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function policyLabel(value: string): string {
  return value
    .split("_")
    .map((part, index) =>
      index === 0 ? `${part.slice(0, 1).toUpperCase()}${part.slice(1)}` : part,
    )
    .join(" ")
    .replace("opt in", "opt-in");
}

export function DirectApiProfileView({ profile }: { profile: DirectApiProfile }) {
  const identity = profile.effectiveIdentity;
  return (
    <div className="direct-api-profile-view">
      <div className="direct-api-profile-status" role="status">
        <strong>{availabilityLabels[profile.availability]}</strong>
        <span>{profile.displayName}</span>
      </div>
      {profile.availabilityReasons.length === 0 ? null : (
        <ul className="direct-api-profile-reasons">
          {profile.availabilityReasons.map((reason) => (
            <li key={reason}>{reasonLabels[reason]}</li>
          ))}
        </ul>
      )}
      <dl className="direct-api-profile-facts">
        <div>
          <dt>Effective route</dt>
          <dd>
            <code>{`${identity.endpointOrigin}${identity.endpointPath}`}</code>
            <span>OpenAI Responses API · version {identity.apiVersion}</span>
          </dd>
        </div>
        <div>
          <dt>Pinned identity</dt>
          <dd>
            <strong>{identity.model.expectedResolvedId}</strong>
            <span>
              Organization {identity.organizationId} · Project {identity.openAiProjectId}
            </span>
          </dd>
        </div>
        <div>
          <dt>Execution policy</dt>
          <dd>
            <strong>Stateless text · strict JSON Schema</strong>
            <span>Tools, URLs, files, retrieval, callbacks, and arbitrary options disabled</span>
          </dd>
        </div>
        <div>
          <dt>Data-policy attestation</dt>
          <dd>
            <strong>{policyLabel(profile.dataPolicy.trainingUse)}</strong>
            <span>
              Abuse monitoring: {policyLabel(profile.dataPolicy.abuseMonitoring)} · Human review:{" "}
              {policyLabel(profile.dataPolicy.humanReview)}
            </span>
            <span>
              Processing: {profile.dataPolicy.processingRegions.join(", ")} · Storage:{" "}
              {profile.dataPolicy.storageRegions.join(", ")} · Expires{" "}
              {formatDate(profile.dataPolicy.expiresAt)}
            </span>
            <a href={profile.dataPolicy.evidenceUrl}>Attestation evidence</a>
          </dd>
        </div>
        <div>
          <dt>Limits</dt>
          <dd>
            <strong>
              {profile.limits.maximumInputTokens.toLocaleString()} input /{" "}
              {profile.limits.maximumOutputTokens.toLocaleString()} output tokens
            </strong>
            <span>
              {profile.limits.maximumConcurrentRequests} concurrent · one attempt · ${""}
              {profile.limits.maximumCostUsd} maximum cost
            </span>
          </dd>
        </div>
        <div>
          <dt>Last successful synthetic test</dt>
          <dd>
            <strong>{formatDate(profile.lastTest.passedAt)}</strong>
            <span>
              Observed {profile.lastTest.observedModel} · {profile.lastTest.observedApiVersion}
            </span>
            <span>
              Attributed Project {profile.lastTest.attributedOpenAiProjectId} · Organization{" "}
              {profile.lastTest.observedOrganizationId}
            </span>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function FormField({
  children,
  defaultValue,
  label,
  name,
  type = "text",
}: {
  children?: ReactNode;
  defaultValue?: string;
  label: string;
  name: string;
  type?: string;
}) {
  return (
    <label className="form-field">
      <span>{label}</span>
      {children ?? (
        <input name={name} type={type} defaultValue={defaultValue} required spellCheck={false} />
      )}
    </label>
  );
}

function textValue(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function regions(data: FormData, name: string): string[] {
  return textValue(data, name)
    .split(",")
    .map((region) => region.trim())
    .filter(Boolean);
}

interface DirectApiProfilePanelProps {
  disabled: boolean;
  onAuthenticationError?: (error: unknown) => boolean;
  onChanged?: (profile: DirectApiProfile) => void;
  projectId: string;
}

export function DirectApiProfilePanel({
  disabled,
  onAuthenticationError,
  onChanged,
  projectId,
}: DirectApiProfilePanelProps) {
  const [profile, setProfile] = useState<DirectApiProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(null);
    void fetchDirectApiProfile(projectId, controller.signal).then(
      (response) => {
        if (active) {
          setProfile(response.profile);
          setLoading(false);
        }
      },
      (caught: unknown) => {
        if (!active || controller.signal.aborted) return;
        setLoading(false);
        if (!onAuthenticationError?.(caught)) {
          setError(
            caught instanceof ApiClientError
              ? `${caught.details.message} Reference: ${caught.details.correlationId}`
              : "Kestrel could not read this Direct API profile.",
          );
        }
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [onAuthenticationError, projectId]);

  const handleConfigure = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const model = textValue(data, "model");
    const cachedPrice = textValue(data, "cachedInputPrice");
    const parsed = ConfigureDirectApiProfileCommandSchema.safeParse({
      apiKey: textValue(data, "apiKey"),
      dataPolicy: {
        abuseMonitoring: textValue(data, "abuseMonitoring"),
        attestedAt: textValue(data, "attestedAt"),
        evidenceUrl: textValue(data, "evidenceUrl"),
        expiresAt: textValue(data, "expiresAt"),
        humanReview: textValue(data, "humanReview"),
        processingRegions: regions(data, "processingRegions"),
        storageRegions: regions(data, "storageRegions"),
        trainingUse: textValue(data, "trainingUse"),
      },
      displayName: textValue(data, "displayName"),
      limits: {
        maximumAttempts: 1,
        maximumConcurrentRequests: Number(textValue(data, "maximumConcurrentRequests")),
        maximumCostUsd: textValue(data, "maximumCostUsd"),
        maximumInputTokens: Number(textValue(data, "maximumInputTokens")),
        maximumOutputTokens: Number(textValue(data, "maximumOutputTokens")),
        maximumRequestBytes: Number(textValue(data, "maximumRequestBytes")),
        requestTimeoutMilliseconds: Number(textValue(data, "requestTimeoutMilliseconds")),
      },
      model: { expectedResolvedId: model, requestedId: model, versionPolicy: "pinned" },
      openAiProjectId: textValue(data, "openAiProjectId"),
      organizationId: textValue(data, "organizationId"),
      priceSnapshot: {
        cachedInputPerMillionTokensUsd: cachedPrice === "" ? null : cachedPrice,
        capturedAt: textValue(data, "priceCapturedAt"),
        currency: "USD",
        effectiveAt: textValue(data, "priceEffectiveAt"),
        inputPerMillionTokensUsd: textValue(data, "inputPrice"),
        outputPerMillionTokensUsd: textValue(data, "outputPrice"),
        sourceUrl: textValue(data, "priceSourceUrl"),
      },
    });
    const password = textValue(data, "currentPassword");
    if (!parsed.success || password.length === 0 || password.length > 128) {
      setError("Complete every profile field with the exact approved values.");
      return;
    }

    setPending(true);
    setError(null);
    try {
      const response = await configureDirectApiProfile(projectId, parsed.data, password);
      if (response.profile === null) throw new Error("Configured profile was absent");
      form.reset();
      setProfile(response.profile);
      setShowForm(false);
      onChanged?.(response.profile);
    } catch (caught) {
      if (!onAuthenticationError?.(caught)) {
        setError(
          caught instanceof ApiClientError
            ? `${caught.details.message} Reference: ${caught.details.correlationId}`
            : "Kestrel could not certify this exact Direct API profile.",
        );
      }
    } finally {
      setPending(false);
    }
  };

  const handleTest = async () => {
    setPending(true);
    setError(null);
    try {
      const response = await testDirectApiProfile(projectId);
      if (response.profile === null) throw new Error("Tested profile was absent");
      setProfile(response.profile);
      onChanged?.(response.profile);
    } catch (caught) {
      if (!onAuthenticationError?.(caught)) {
        setError(
          caught instanceof ApiClientError
            ? `${caught.details.message} Reference: ${caught.details.correlationId}`
            : "Kestrel could not re-test this Direct API profile.",
        );
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="direct-api-profile" aria-labelledby={`direct-api-profile-${projectId}`}>
      <div className="direct-api-profile-heading">
        <div>
          <p className="section-index">MODEL PROVIDER</p>
          <h4 id={`direct-api-profile-${projectId}`}>Direct API profile</h4>
        </div>
        <div className="direct-api-profile-actions">
          {profile === null ? null : (
            <button
              className="secondary-action"
              type="button"
              disabled={disabled || pending}
              onClick={() => void handleTest()}
            >
              {pending ? "Testing…" : "Run profile test"}
            </button>
          )}
          <button
            className="secondary-action"
            type="button"
            disabled={disabled || pending}
            onClick={() => setShowForm((current) => !current)}
          >
            {showForm ? "Cancel" : profile === null ? "Configure profile" : "Replace profile"}
          </button>
        </div>
      </div>
      {loading ? <p aria-busy="true">Reading the effective profile…</p> : null}
      {!loading && profile === null ? (
        <p className="direct-api-profile-empty">
          No model route is configured. Repository source remains local.
        </p>
      ) : null}
      {profile === null ? null : <DirectApiProfileView profile={profile} />}
      {error === null ? null : (
        <p className="project-form-error" role="alert">
          {error}
        </p>
      )}
      {showForm ? (
        <form className="direct-api-profile-form" onSubmit={(event) => void handleConfigure(event)}>
          <p>
            The key is sent only to the web broker after password step-up. It is never returned to
            or retained by this browser.
          </p>
          <fieldset>
            <legend>Credential and effective identity</legend>
            <div className="direct-api-form-grid">
              <FormField label="Current Operator password" name="currentPassword" type="password">
                <input
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </FormField>
              <FormField label="Project-exclusive OpenAI key" name="apiKey" type="password">
                <input name="apiKey" type="password" autoComplete="off" required />
              </FormField>
              <FormField
                label="Profile name"
                name="displayName"
                defaultValue="OpenAI direct review"
              />
              <FormField label="OpenAI organization ID" name="organizationId" />
              <FormField label="OpenAI Project ID" name="openAiProjectId" />
              <FormField label="Pinned model snapshot ID" name="model" />
            </div>
          </fieldset>
          <fieldset>
            <legend>Data-policy attestation</legend>
            <div className="direct-api-form-grid">
              <FormField label="Training use" name="trainingUse">
                <select name="trainingUse" defaultValue="not_used_without_opt_in" required>
                  <option value="not_used_without_opt_in">Not used without opt-in</option>
                  <option value="provider_may_train">Provider may train</option>
                </select>
              </FormField>
              <FormField label="Abuse monitoring" name="abuseMonitoring">
                <select name="abuseMonitoring" defaultValue="standard" required>
                  <option value="standard">Standard</option>
                  <option value="modified">Modified</option>
                  <option value="zero_data_retention">Zero data retention</option>
                </select>
              </FormField>
              <FormField label="Human review" name="humanReview">
                <select name="humanReview" defaultValue="possible" required>
                  <option value="possible">Possible</option>
                  <option value="restricted">Restricted</option>
                  <option value="none_attested">None attested</option>
                </select>
              </FormField>
              <FormField label="Attested at (UTC ISO 8601)" name="attestedAt" />
              <FormField label="Expires at (UTC ISO 8601)" name="expiresAt" />
              <FormField label="Evidence URL" name="evidenceUrl" type="url" />
              <FormField
                label="Processing regions (comma separated)"
                name="processingRegions"
                defaultValue="US"
              />
              <FormField
                label="Storage regions (comma separated)"
                name="storageRegions"
                defaultValue="US"
              />
            </div>
          </fieldset>
          <fieldset>
            <legend>Request and cost limits</legend>
            <div className="direct-api-form-grid">
              <FormField
                label="Maximum concurrent requests"
                name="maximumConcurrentRequests"
                type="number"
                defaultValue="1"
              />
              <FormField
                label="Maximum input tokens"
                name="maximumInputTokens"
                type="number"
                defaultValue="100000"
              />
              <FormField
                label="Maximum output tokens"
                name="maximumOutputTokens"
                type="number"
                defaultValue="8192"
              />
              <FormField
                label="Maximum request bytes"
                name="maximumRequestBytes"
                type="number"
                defaultValue="1048576"
              />
              <FormField
                label="Timeout milliseconds"
                name="requestTimeoutMilliseconds"
                type="number"
                defaultValue="60000"
              />
              <FormField label="Maximum cost USD" name="maximumCostUsd" defaultValue="2.500000" />
            </div>
          </fieldset>
          <fieldset>
            <legend>USD price snapshot per million tokens</legend>
            <div className="direct-api-form-grid">
              <FormField label="Input price" name="inputPrice" />
              <FormField label="Cached input price (optional)" name="cachedInputPrice">
                <input name="cachedInputPrice" type="text" inputMode="decimal" />
              </FormField>
              <FormField label="Output price" name="outputPrice" />
              <FormField label="Effective at (UTC ISO 8601)" name="priceEffectiveAt" />
              <FormField label="Captured at (UTC ISO 8601)" name="priceCapturedAt" />
              <FormField label="Price source URL" name="priceSourceUrl" type="url" />
            </div>
          </fieldset>
          <button type="submit" disabled={disabled || pending}>
            {pending ? "Certifying exact profile…" : "Certify and save profile"}
          </button>
        </form>
      ) : null}
    </section>
  );
}
