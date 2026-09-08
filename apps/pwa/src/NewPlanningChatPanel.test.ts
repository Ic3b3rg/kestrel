// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewPlanningChatPanel, type NewPlanningChatPanelProps } from "./NewPlanningChatPanel.js";

describe("blank planning conversation", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
    vi.unstubAllGlobals();
  });
  async function render(overrides: Partial<NewPlanningChatPanelProps> = {}) {
    await act(async () => {
      root.render(
        createElement(NewPlanningChatPanel, {
          projectName: "Reports",
          online: true,
          pending: false,
          error: null,
          onSubmit: vi.fn(),
          onBack: vi.fn(),
          ...overrides,
        }),
      );
      await Promise.resolve();
    });
  }
  function textarea(): HTMLTextAreaElement {
    const found = container.querySelector("textarea");
    if (found === null) throw new Error("Missing planning composer");
    return found;
  }
  async function type(text: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea(),
        text,
      );
      textarea().dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
  }
  async function submit() {
    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
  }

  it("opens a focused, labelled composer without a title field or an empty submission", async () => {
    const onSubmit = vi.fn();
    await render({ onSubmit });
    expect(document.activeElement).toBe(textarea());
    expect(container.querySelector("label")?.htmlFor).toBe(textarea().id);
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(container.textContent).toContain("Reports");
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      true,
    );
    await type(" \n ");
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the first prompt and retains it through a pending request and retry", async () => {
    const onSubmit = vi.fn();
    await render({ onSubmit });
    await type("  Let people search saved reports.  ");
    await submit();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Let people search saved reports.");
    await render({ onSubmit, pending: true });
    expect(textarea().value).toBe("  Let people search saved reports.  ");
    expect(textarea().disabled).toBe(true);
    await submit();
    expect(onSubmit).toHaveBeenCalledOnce();
    await render({ onSubmit, error: "The first message could not be confirmed." });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "could not be confirmed",
    );
    expect(textarea().value).toBe("  Let people search saved reports.  ");
    await submit();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[1]).toEqual(["Let people search saved reports."]);
  });

  it("allows an offline draft while blocking its submission until reconnection", async () => {
    const onSubmit = vi.fn();
    await render({ online: false, onSubmit });
    await type("Search archived reports too.");
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Reconnect to start");
    await render({ onSubmit });
    await submit();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Search archived reports too.");
  });

  it("supports modified Enter without intercepting multiline input or composition", async () => {
    const onSubmit = vi.fn();
    await render({ onSubmit });
    await type("Search saved reports.");
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          isComposing: true,
          bubbles: true,
        }),
      );
      await Promise.resolve();
    });
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => {
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Search saved reports.");
  });

  it("returns to the board through a native button", async () => {
    const onBack = vi.fn();
    await render({ onBack });
    const back = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Back to board"),
    );
    expect(back?.type).toBe("button");
    await act(async () => {
      back?.click();
      await Promise.resolve();
    });
    expect(onBack).toHaveBeenCalledOnce();
  });
});
