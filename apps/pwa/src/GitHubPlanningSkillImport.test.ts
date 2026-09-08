// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  InstallGitHubPlanningSkillCommandSchema,
  type GitHubPlanningSkillBundle,
} from "@kestrel/contracts";
import { GitHubPlanningSkillImport } from "./GitHubPlanningSkillImport.js";
import { ApiClientError } from "./api.js";

const bundle: GitHubPlanningSkillBundle = {
  name: "grilling-starter",
  description: "Ask grounded questions and propose a plan.",
  contentDigest: "a".repeat(64),
  source: {
    kind: "github",
    label: "mattpocock/skills",
    candidateId: "b".repeat(64),
    owner: "mattpocock",
    repository: "skills",
    path: "skills/engineering/grill-with-docs/SKILL.md",
    requestedRef: "c".repeat(40),
    commitId: "c".repeat(40),
  },
  files: [
    { path: "SKILL.md", content: "Ask one question. <script>window.executed = true</script>" },
    { path: "sources/LICENSE", content: "MIT License. Copyright Matt Pocock." },
    { path: ".kestrel/source.json", content: "Separate Kestrel source attribution." },
  ],
};
const installed = vi.fn();
const authentication = vi.fn<(error: unknown) => boolean>(() => false);
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "cookie", "get").mockReturnValue(
    `__Host-kestrel-csrf=${"a".repeat(43)}.${"b".repeat(43)}`,
  );
  installed.mockReset();
  authentication.mockReset().mockReturnValue(false);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(online = true, open?: boolean) {
  await act(async () => {
    root.render(
      createElement(GitHubPlanningSkillImport, {
        online,
        onInstalled: installed,
        onAuthenticationError: authentication,
        ...(open === undefined ? {} : { dialog: { open, onOpenChange: vi.fn() } }),
      }),
    );
    await Promise.resolve();
  });
}
function button(label: string) {
  return [...document.body.querySelectorAll("button")].find(
    (element) => element.textContent.trim() === label,
  );
}
function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}
function requestBody(options?: RequestInit): unknown {
  if (typeof options?.body !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(options.body) as unknown;
}
async function click(label: string) {
  const target = button(label);
  expect(target, label).toBeDefined();
  await act(async () => {
    target?.click();
    await Promise.resolve();
  });
}
async function change(label: string, value: string) {
  const fieldLabel = [...container.querySelectorAll("label")].find(
    (element) => element.textContent === label,
  );
  const field = document.getElementById(fieldLabel?.htmlFor ?? "");
  expect(field, label).not.toBeNull();
  await act(async () => {
    if (field instanceof HTMLSelectElement) {
      field.value = value;
      field.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (field instanceof HTMLInputElement) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await Promise.resolve();
  });
}

it("previews full provenance and inert files, then retries exactly the reviewed install after a lost response", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  let installs = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, options) => {
      const url = requestUrl(input);
      requests.push({ url, body: requestBody(options) });
      expect(options?.credentials).toBe("same-origin");
      expect(new Headers(options?.headers).get("X-Kestrel-CSRF")).not.toBeNull();
      if (url.endsWith("/install") && ++installs === 1)
        return Promise.reject(new TypeError("Response lost"));
      return Promise.resolve(Response.json(bundle));
    }),
  );
  await render();
  expect(button("Install reviewed version")).toBeUndefined();
  await click("Preview Skill");
  expect(requests).toEqual([
    {
      url: "/api/v1/planning-skills/github/preview",
      body: { kind: "starter", starter: "grilling-starter" },
    },
  ]);
  expect(container.textContent).toContain(bundle.source.commitId);
  expect(container.textContent).toContain(bundle.source.path);
  expect(container.textContent).toContain("Ask one question.");
  expect(container.querySelector("script")).toBeNull();
  await change("Instructions and references", "sources/LICENSE");
  expect(container.textContent).toContain("MIT License. Copyright Matt Pocock.");
  expect(installed).not.toHaveBeenCalled();
  await click("Install reviewed version");
  expect(container.querySelector("select")?.disabled).toBe(true);
  await render(false);
  expect(button("Retry installation")?.disabled).toBe(true);
  await render();
  await click("Retry installation");
  expect(requests[1]?.body).toEqual(requests[2]?.body);
  expect(InstallGitHubPlanningSkillCommandSchema.parse(requests[1]?.body).digest).toBe(
    bundle.contentDigest,
  );
  expect(installed).toHaveBeenCalledExactlyOnceWith(bundle);
  expect(container.textContent).toContain("Installed");
  expect(requests.map(({ url }) => url)).toEqual([
    "/api/v1/planning-skills/github/preview",
    "/api/v1/planning-skills/github/install",
    "/api/v1/planning-skills/github/install",
  ]);
});

it("retains the reviewed version and uncertain install request when its dialog closes and reopens", async () => {
  const commands: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, options) => {
      if (requestUrl(input).endsWith("/install")) {
        commands.push(requestBody(options));
        if (commands.length === 1) return Promise.reject(new TypeError("Response lost"));
      }
      return Promise.resolve(Response.json(bundle));
    }),
  );
  await render(true, true);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await click("Preview Skill");
  await click("Install reviewed version");
  await render(true, false);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await render(true, true);
  expect(document.body.textContent).toContain(bundle.source.commitId);
  await click("Retry installation");
  expect(commands).toHaveLength(2);
  expect(commands[0]).toEqual(commands[1]);
  expect(installed).toHaveBeenCalledExactlyOnceWith(bundle);
});

it("discards a slow preview when the requested ref changes", async () => {
  let resolvePreview: ((value: Response) => void) | undefined;
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((_input, options) => {
      signal = options?.signal;
      return new Promise((resolve) => {
        resolvePreview = resolve;
      });
    }),
  );
  await render();
  await change("Source", "github");
  await change("Owner", "mattpocock");
  await change("Repository", "skills");
  await change("Skill entry path", bundle.source.path);
  await click("Preview Skill");
  await change("Ref", "release");
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    resolvePreview?.(Response.json(bundle));
    await Promise.resolve();
  });
  expect(button("Install reviewed version")).toBeUndefined();
  expect(container.textContent).not.toContain(bundle.source.commitId);
});

it("keeps a mismatched install response uncertain and never reports it installed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input) =>
      Promise.resolve(
        Response.json(
          requestUrl(input).endsWith("/install")
            ? { ...bundle, contentDigest: "d".repeat(64) }
            : bundle,
        ),
      ),
    ),
  );
  await render();
  await click("Preview Skill");
  await click("Install reviewed version");
  expect(installed).not.toHaveBeenCalled();
  expect(button("Retry installation")?.disabled).toBe(false);
});

it("rejects a preview whose source does not match the requested ref", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(bundle));
  vi.stubGlobal("fetch", fetch);
  await render();
  await change("Source", "github");
  await change("Owner", bundle.source.owner);
  await change("Repository", bundle.source.repository);
  await change("Skill entry path", bundle.source.path);
  await change("Ref", "release");
  await click("Preview Skill");
  expect(button("Install reviewed version")).toBeUndefined();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(fetch).toHaveBeenCalledOnce();
  expect(installed).not.toHaveBeenCalled();
});

it("delegates an expired Operator session without showing an installable preview", async () => {
  authentication.mockReturnValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          schemaVersion: 1,
          code: "AUTHENTICATION_REQUIRED",
          message: "Sign in again",
          correlationId: "01900000-0000-7000-8000-000000000001",
        },
        { status: 401 },
      ),
    ),
  );
  await render();
  await click("Preview Skill");
  expect(authentication).toHaveBeenCalledOnce();
  expect(authentication.mock.calls[0]?.[0]).toBeInstanceOf(ApiClientError);
  expect(button("Install reviewed version")).toBeUndefined();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("ignores a successful install response after unmount", async () => {
  let complete: ((value: Response) => void) | undefined;
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, options) => {
      if (requestUrl(input).endsWith("/preview")) return Promise.resolve(Response.json(bundle));
      signal = options?.signal;
      return new Promise((resolve) => {
        complete = resolve;
      });
    }),
  );
  await render();
  await click("Preview Skill");
  await click("Install reviewed version");
  await act(async () => {
    root.render(null);
    await Promise.resolve();
  });
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    complete?.(Response.json(bundle));
    await Promise.resolve();
  });
  expect(installed).not.toHaveBeenCalled();
  expect(container.textContent).toBe("");
});

it("aborts an unmounted preview and ignores its late response", async () => {
  let complete: ((value: Response) => void) | undefined;
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((_input, options) => {
      signal = options?.signal;
      return new Promise((resolve) => {
        complete = resolve;
      });
    }),
  );
  await render();
  await click("Preview Skill");
  await act(async () => {
    root.render(null);
    await Promise.resolve();
  });
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    complete?.(Response.json(bundle));
    await Promise.resolve();
  });
  expect(installed).not.toHaveBeenCalled();
  expect(container.textContent).toBe("");
});
