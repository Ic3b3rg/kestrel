import { vi } from "vitest";
import {
  defaultLifecycleSettings,
  resolveLifecycleProfile,
  type LifecyclePhase,
} from "@kestrel/contracts";

export function lifecycleProfileFixture(phase: LifecyclePhase = "planning") {
  const models = [{ id: "fixture-model", displayName: "Fixture model", isDefault: true }];
  return {
    phase,
    versions: { installation: 0, project: 0 },
    defaults: defaultLifecycleSettings,
    overrides: {},
    models,
    blocked: null,
    resolved: {
      ...resolveLifecycleProfile(defaultLifecycleSettings, {}, models),
      phase,
      versions: { installation: 0, project: 0 },
      skills: [],
    },
  };
}

export function mockLifecycleProfileRequests() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/lifecycle-profiles/"))
        return Promise.resolve(
          Response.json(
            lifecycleProfileFixture(
              url.endsWith("implementation")
                ? "implementation"
                : url.endsWith("corrections")
                  ? "corrections"
                  : "planning",
            ),
          ),
        );
      return Promise.reject(new Error("No fixture for this request"));
    }),
  );
}
