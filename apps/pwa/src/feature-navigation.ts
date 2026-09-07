import { KestrelIdSchema } from "@kestrel/contracts";

const FEATURE_NAVIGATION_KEY = "kestrel.feature-navigation";

/** Navigation hints only. A successful server read is required before displaying a chat. */
export function readFeatureNavigation(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(FEATURE_NAVIGATION_KEY) ?? "{}");
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw)
        .filter(
          ([projectId, featureId]) =>
            KestrelIdSchema.safeParse(projectId).success &&
            KestrelIdSchema.safeParse(featureId).success,
        )
        .slice(0, 200),
    );
  } catch {
    return {};
  }
}

export function saveFeatureNavigation(features: Readonly<Record<string, string>>): void {
  try {
    if (Object.keys(features).length === 0) sessionStorage.removeItem(FEATURE_NAVIGATION_KEY);
    else sessionStorage.setItem(FEATURE_NAVIGATION_KEY, JSON.stringify(features));
  } catch {
    // Browser storage is optional; URLs and server records remain usable.
  }
}
