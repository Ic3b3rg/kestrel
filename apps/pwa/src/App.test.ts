// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ProjectInbox, Session, ProjectBoardSnapshot } from "@kestrel/contracts";
import { App } from "./App.js";
import type * as apiModule from "./api.js";
const api = vi.hoisted(() => ({
  session: vi.fn<typeof apiModule.fetchSession>(),
  inbox: vi.fn<typeof apiModule.fetchProjectInbox>(),
  board: vi.fn<typeof apiModule.fetchProjectBoard>(),
}));
vi.mock("./api.js", async (original) => ({
  ...(await original<typeof apiModule>()),
  fetchSession: api.session,
  fetchProjectInbox: api.inbox,
  fetchProjectBoard: api.board,
  fetchFeatures: () => Promise.resolve({ schemaVersion: 1, features: [] }),
}));
const projectId = "01991c36-7f90-7000-8000-000000000001";
const at = "2026-09-23T12:00:00.000Z";
it("keeps the Project board mounted and readable when the host goes offline", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", `/projects/${projectId}`);
  const session: Session = {
    schemaVersion: 1,
    operator: { id: projectId, username: "operator" },
    credentialVersion: "1",
    issuedAt: at,
    expiresAt: "2026-09-30T12:00:00.000Z",
  };
  const inbox: ProjectInbox = {
    schemaVersion: 1,
    projects: [
      {
        id: projectId,
        changeProposals: [],
        createdAt: at,
        updatedAt: at,
        localRepositorySource: null,
        modelAccess: "not_configured",
        sourceAvailability: "not_acquired",
        providerObservation: null,
        repository: {
          owner: "example",
          name: "reports",
          canonicalUrl: "https://github.com/example/reports",
          providerId: "1",
        },
      },
    ],
  };
  const board: ProjectBoardSnapshot = {
    schemaVersion: 1,
    projectId,
    readAt: at,
    planningFeatures: [
      {
        schemaVersion: 1,
        id: "01991c36-7f90-7000-8000-000000000002",
        projectId,
        title: "Retained local planning",
        state: "planning",
        createdAt: at,
        updatedAt: at,
      },
    ],
    workItems: [],
    github: {
      issues: [],
      checkedAt: at,
      fetchedAt: at,
      limited: false,
      failure: null,
      retained: false,
    },
  };
  api.session.mockResolvedValue(session);
  api.inbox.mockResolvedValue(inbox);
  api.board.mockResolvedValue(board);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(App));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Retained local planning");
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Retained local planning");
    expect(container.textContent).toContain("Reconnect to refresh this board");
    expect(api.board.mock.calls[0]?.[1]?.aborted).toBe(true);
  } finally {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  }
});
