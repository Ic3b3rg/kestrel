// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { InterviewSkillPicker } from "./InterviewSkillPicker.js";

it("starts closed, searches by collection and closes after a single selection", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        schemaVersion: 1,
        skills: [
          {
            name: "brainstorming",
            description: "Explore an idea",
            contentDigest: "b".repeat(64),
            source: { kind: "host", label: "Superpowers", candidateId: "a".repeat(64) },
          },
        ],
      }),
    ),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changed = vi.fn();
  try {
    await act(
      async () =>
        await Promise.resolve(
          root.render(
            createElement(InterviewSkillPicker, {
              skills: [],
              online: true,
              disabled: false,
              onSelect: changed,
              onAuthenticationError: () => false,
            }),
          ),
        ),
    );
    expect(document.querySelector('input[placeholder="Search skills or collections…"]')).toBeNull();
    await act(async () => {
      host.querySelector("button")?.click();
      await Promise.resolve();
    });
    const option = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent.includes("brainstorming"),
    );
    expect(option).toBeDefined();
    await act(async () => {
      option?.click();
      await Promise.resolve();
    });
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ name: "brainstorming" }));
    expect(document.querySelector('input[placeholder="Search skills or collections…"]')).toBeNull();
  } finally {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    host.remove();
    vi.unstubAllGlobals();
  }
});
