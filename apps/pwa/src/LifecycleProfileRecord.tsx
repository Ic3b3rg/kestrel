import type { z } from "zod";
import type {
  LifecycleProfileEvidenceSchema,
  RuntimeProfileResultSchema,
} from "@kestrel/contracts";

export function LifecycleProfileRecord({
  profile,
  effective,
  label = "Profile used",
}: {
  profile: z.infer<typeof LifecycleProfileEvidenceSchema> | null | undefined;
  effective?: z.infer<typeof RuntimeProfileResultSchema> | null | undefined;
  label?: string;
}) {
  return (
    <details className="min-w-0 rounded-md border border-border p-3 text-sm [overflow-wrap:anywhere]">
      <summary className="cursor-pointer font-medium">
        {label}
        {profile == null
          ? ""
          : ` · ${profile.modelId} · ${profile.effort ?? "Runtime default"} · ${profile.serviceTier === "default" ? "Standard" : (profile.serviceTier ?? "Runtime default")}`}
      </summary>
      {profile == null ? (
        <p className="mt-2 text-muted-foreground">
          This older record has no lifecycle profile. New work requires an available profile in
          Lifecycle settings.
        </p>
      ) : (
        <div className="mt-2 grid gap-2">
          <p>
            {profile.modelId} · Effort: {profile.effort ?? "Runtime default"} · Speed:{" "}
            {profile.serviceTier === "default"
              ? "Standard"
              : (profile.serviceTier ?? "Runtime default")}
          </p>
          <p>
            Runtime:{" "}
            {profile.runtimeId === "codex_subscription" ? "Codex subscription" : profile.runtimeId}
          </p>
          <p>
            {profile.skills.length === 0
              ? "No Skills selected."
              : `Skills: ${profile.skills.map((skill) => `${skill.name} (${skill.contentDigest.slice(0, 12)})`).join(", ")}`}
          </p>
          <p className="text-muted-foreground">
            {effective == null
              ? "The runtime has not reported its effective settings."
              : `Runtime reported: ${effective.model ?? "model unreported"} · Effort: ${effective.effort ?? "unreported"} · Speed: ${effective.serviceTier === "default" ? "Standard" : (effective.serviceTier ?? "unreported")}`}
          </p>
        </div>
      )}
    </details>
  );
}
