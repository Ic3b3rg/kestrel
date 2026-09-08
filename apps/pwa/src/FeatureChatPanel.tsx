import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Pencil, RefreshCw, Send, Square } from "lucide-react";
import type {
  Feature,
  FeatureChat,
  RenameFactoryFeatureCommand,
  SendPlanningMessageCommand,
} from "@kestrel/contracts";

import {
  ApiClientError,
  cancelPlanningTurn,
  fetchFeatureChat,
  retryPlanningTurn,
  sendPlanningMessage,
} from "./api.js";
import { appPath, type AppRoute } from "./app-route.js";
import { handleFeatureLink, planningRequestError } from "./FeatureNavigation.js";
import { Button } from "./components/ui/button.js";
import { DocumentInspector, failures, pendingTurn } from "./PlanningDetails.js";
import { FeaturePlanPanel } from "./FeaturePlanPanel.js";
import { FeatureBoardPanel } from "./FeatureBoardPanel.js";
import { PlanningSkillsPanel, SkillProvenance } from "./PlanningSkillsPanel.js";
import { FeatureGitHubIssuesPanel } from "./FeatureGitHubIssuesPanel.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.js";
import { Label } from "./components/ui/label.js";
import { Textarea } from "./components/ui/textarea.js";
import { Input } from "./components/ui/input.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog.js";
import { renameFactoryFeature } from "./factory-start-api.js";

const ignoreDirtyChange = () => undefined;
const featureStatus: Record<Feature["state"], string> = {
  planning: "Planning · Define the outcome before implementation.",
  queued: "Queued · Approved work is waiting to run.",
  implementing: "In progress · Approved work is running on the workstation.",
  gated: "Decision needed · Review the blocked work on the board.",
  in_review: "In review · Inspect the work and its verification results.",
  cancelled: "Cancelled · Saved work remains available.",
};

type Attempt =
  | { kind: "send"; command: SendPlanningMessageCommand }
  | { kind: "retry"; turnId: string; requestId: string }
  | { kind: "cancel"; turnId: string };

function FeatureTitleControl({
  feature,
  online,
  onRenamed,
  onAuthenticationError,
  rename,
}: {
  feature: Feature;
  online: boolean;
  onRenamed: (feature: Feature) => void;
  onAuthenticationError: (error: unknown) => boolean;
  rename: typeof renameFactoryFeature;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(feature.title);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<RenameFactoryFeatureCommand | null>(null);
  const submitting = useRef(false);
  const alive = useRef(true);
  const enabled = useRef(online);
  enabled.current = online;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!online || submitting.current || title.trim() === "") return;
    submitting.current = true;
    setPending(true);
    setError(null);
    attempt.current ??= { requestId: crypto.randomUUID(), title: title.trim() };
    try {
      const result = await rename(feature.projectId, feature.id, attempt.current);
      if (!alive.current) return;
      if (result.id !== feature.id) throw new Error("A different Feature was returned");
      if (!enabled.current) {
        setError("Reconnect and retry to confirm the saved name.");
        return;
      }
      attempt.current = null;
      onRenamed(result);
      setOpen(false);
    } catch (failure) {
      if (alive.current && !onAuthenticationError(failure))
        setError(
          planningRequestError(
            failure,
            "The name could not be confirmed. Retry the same rename safely.",
          ),
        );
    } finally {
      submitting.current = false;
      if (alive.current) setPending(false);
    }
  };
  return (
    <Dialog
      open={open && online}
      onOpenChange={(value) => {
        if (!pending) setOpen(value);
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          disabled={!online}
          onClick={() => {
            if (attempt.current === null) setTitle(feature.title);
            setOpen(true);
          }}
        >
          <Pencil aria-hidden="true" /> Rename feature
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={!pending}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogTitle>Rename feature</DialogTitle>
        <DialogDescription>Your name will be kept when Kestrel replies.</DialogDescription>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <Label htmlFor="feature-name">Feature name</Label>
          <Input
            id="feature-name"
            value={title}
            maxLength={160}
            disabled={pending || error !== null}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
          {error === null ? null : <p role="alert">{error}</p>}
          <Button type="submit" disabled={!online || pending || title.trim() === ""}>
            {pending ? "Saving…" : error === null ? "Save name" : "Retry rename"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface FeatureChatPanelProps {
  projectId: string;
  projectName: string;
  featureId: string;
  online: boolean;
  view?: "chat" | "plan" | "board";
  onPlanDirtyChange?: (dirty: boolean) => void;
  onNavigate: (route: Exclude<AppRoute, { kind: "not_found" }>) => void;
  onAuthenticationError: (error: unknown) => boolean;
  onFeatureRead: (feature: Feature) => void;
  onFeatureUnavailable: (projectId: string, featureId: string) => void;
  loadChat?: typeof fetchFeatureChat;
  sendMessage?: typeof sendPlanningMessage;
  retryTurn?: typeof retryPlanningTurn;
  cancelTurn?: typeof cancelPlanningTurn;
  renameFeature?: typeof renameFactoryFeature;
}

export function FeatureChatPanel({
  projectId,
  projectName,
  featureId,
  online,
  view = "chat",
  onPlanDirtyChange = ignoreDirtyChange,
  onNavigate,
  onAuthenticationError,
  onFeatureRead,
  onFeatureUnavailable,
  loadChat = fetchFeatureChat,
  sendMessage = sendPlanningMessage,
  retryTurn = retryPlanningTurn,
  cancelTurn = cancelPlanningTurn,
  renameFeature = renameFactoryFeature,
}: FeatureChatPanelProps) {
  const [chat, setChat] = useState<FeatureChat | null>(null);
  const [reading, setReading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [importsRevision, setImportsRevision] = useState(0);
  const [commandPending, setCommandPending] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [attemptKind, setAttemptKind] = useState<Attempt["kind"] | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const activeRead = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const submitting = useRef(false);

  const refresh = useCallback(async () => {
    if (!online) return;
    const controller = new AbortController();
    activeRead.current?.abort();
    activeRead.current = controller;
    setReading(true);
    setReadError(null);
    try {
      const result = await loadChat(projectId, featureId, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      if (result.feature.id !== featureId)
        throw new Error("The response contains a different feature");
      setChat(result);
      onFeatureRead(result.feature);
    } catch (failure) {
      if (!alive.current || controller.signal.aborted || onAuthenticationError(failure)) return;
      if (failure instanceof ApiClientError && failure.status === 404)
        onFeatureUnavailable(projectId, featureId);
      setReadError(
        planningRequestError(failure, "The conversation could not be loaded. Refresh to retry."),
      );
    } finally {
      if (alive.current && activeRead.current === controller) setReading(false);
    }
  }, [
    online,
    loadChat,
    projectId,
    featureId,
    onFeatureRead,
    onFeatureUnavailable,
    onAuthenticationError,
  ]);

  useEffect(() => {
    alive.current = true;
    if (online) void refresh();
    else setReading(false);
    return () => {
      alive.current = false;
      activeRead.current?.abort();
    };
  }, [online, refresh]);

  const latestTurn = chat?.turns.at(-1);
  const activeTurn = chat?.turns.find(pendingTurn);
  useEffect(() => {
    if (
      !online ||
      readError !== null ||
      (activeTurn === undefined &&
        chat?.feature.state !== "queued" &&
        chat?.feature.state !== "implementing")
    )
      return;
    const timer = window.setTimeout(() => void refresh(), 1_000);
    return () => window.clearTimeout(timer);
  }, [online, activeTurn, readError, refresh, chat]);

  const runAttempt = async (next?: Attempt) => {
    if (!online || submitting.current) return;
    if (next !== undefined) attempt.current = next;
    const current = attempt.current;
    if (current === null) return;
    submitting.current = true;
    setAttemptKind(current.kind);
    setCommandPending(true);
    setCommandError(null);
    try {
      // Never couple accepted planning work to a component's AbortController.
      if (current.kind === "send") await sendMessage(projectId, featureId, current.command);
      else if (current.kind === "retry")
        await retryTurn(projectId, featureId, current.turnId, { requestId: current.requestId });
      else await cancelTurn(projectId, featureId, current.turnId);
      if (!alive.current) return;
      attempt.current = null;
      if (current.kind === "send") setDraft("");
      await refresh();
    } catch (failure) {
      if (alive.current && !onAuthenticationError(failure)) {
        setCommandError(
          planningRequestError(
            failure,
            "Kestrel could not confirm this request. Retry to check the same request safely.",
          ),
        );
        void refresh();
      }
    } finally {
      submitting.current = false;
      if (alive.current) setCommandPending(false);
    }
  };
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      chat?.feature.state !== "planning" ||
      draft.trim() === "" ||
      commandError !== null ||
      activeTurn !== undefined
    )
      return;
    void runAttempt({
      kind: "send",
      command: {
        requestId: crypto.randomUUID(),
        text: draft.trim(),
        ...(chat.skills === undefined ? {} : { skillSelectionVersion: chat.skills.version }),
      },
    });
  };
  const editable = chat?.feature.state === "planning";
  const selectView = (value: string) => {
    if (value !== "chat" && value !== "plan" && value !== "board") return;
    onNavigate({
      kind: "feature",
      projectId,
      featureId,
      ...(value === "chat" ? {} : { view: value }),
    });
  };
  const projectRoute = { kind: "project" as const, projectId };

  if (chat === null)
    return (
      <section className="workspace-state" aria-busy={reading}>
        <h1>
          {!online
            ? "Reconnect to view this chat"
            : reading
              ? "Loading conversation"
              : "Conversation unavailable"}
        </h1>
        {readError === null ? null : <p role="alert">{readError}</p>}
        {!online ? (
          <p>Your accepted messages remain saved on the workstation.</p>
        ) : (
          <Button variant="outline" disabled={reading} onClick={() => void refresh()}>
            Refresh conversation
          </Button>
        )}
      </section>
    );

  return (
    <section className="feature-planning" aria-labelledby="feature-title">
      <header className="feature-planning-header">
        <div>
          <a
            href={appPath(projectRoute)}
            onClick={(event) => handleFeatureLink(event, projectRoute, onNavigate)}
          >
            {projectName}
          </a>
          <h1 id="feature-title">{chat.feature.title}</h1>
          <FeatureTitleControl
            feature={chat.feature}
            online={online}
            rename={renameFeature}
            onAuthenticationError={onAuthenticationError}
            onRenamed={(feature) => {
              setChat((current) => (current === null ? current : { ...current, feature }));
              onFeatureRead(feature);
              void refresh();
            }}
          />
          <p>{featureStatus[chat.feature.state]}</p>
        </div>
        <div className="feature-planning-actions">
          <DocumentInspector context={chat.context} />
          <PlanningSkillsPanel
            projectId={projectId}
            featureId={featureId}
            online={online}
            editable={editable && activeTurn === undefined}
            selection={chat.skills ?? { schemaVersion: 1, version: 0, skills: [] }}
            onChanged={() => void refresh()}
            onAuthenticationError={onAuthenticationError}
          />

          <FeatureGitHubIssuesPanel
            projectId={projectId}
            featureId={featureId}
            online={online}
            onAuthenticationError={onAuthenticationError}
            onChanged={() => {
              setImportsRevision((value) => value + 1);
              void refresh();
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh conversation"
            disabled={reading || !online}
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        </div>
      </header>
      <Tabs value={view} onValueChange={selectView} className="feature-tabs">
        <TabsList aria-label="Feature views" className="feature-tab-list">
          {(["chat", "plan", "board"] as const).map((value) => {
            const route = {
              kind: "feature" as const,
              projectId,
              featureId,
              ...(value === "chat" ? {} : { view: value }),
            };
            return (
              <TabsTrigger
                asChild
                value={value}
                key={value}
                onMouseDown={(event) => {
                  if (
                    event.button !== 0 ||
                    event.altKey ||
                    event.ctrlKey ||
                    event.metaKey ||
                    event.shiftKey
                  )
                    event.preventDefault();
                }}
              >
                <a
                  href={appPath(route)}
                  onClick={(event) =>
                    handleFeatureLink(event, route, (next) => {
                      if (view !== value) onNavigate(next);
                    })
                  }
                >
                  {value === "chat" ? "Chat" : value === "plan" ? "Plan" : "Board"}
                </a>
              </TabsTrigger>
            );
          })}
        </TabsList>
        <TabsContent value="chat" className="feature-chat-content">
          {readError === null ? null : (
            <p className="planning-error" role="alert">
              {readError}
            </p>
          )}
          {chat.context?.notice === null || chat.context?.notice === undefined ? null : (
            <p className="planning-notice">{chat.context.notice}</p>
          )}
          {(chat.skills?.skills.length ?? 0) === 0 ? null : (
            <p
              className="text-xs text-muted-foreground"
              aria-label="Skills guiding the next message"
            >
              Next message: {chat.skills?.skills.map((skill) => `$${skill.name}`).join(", ")}
            </p>
          )}
          {chat.messages.length === 0 && editable ? (
            <div className="planning-empty">
              <h2>What do you want to build?</h2>
              <p>
                Describe what you want to change, who it helps, and what a good result looks like.
                Kestrel will help you resolve the important questions.
              </p>
            </div>
          ) : null}
          <ol
            className="planning-messages"
            aria-label="Conversation"
            aria-live="polite"
            aria-relevant="additions text"
          >
            {chat.messages.map((message) => {
              const turn = chat.turns.filter(({ messageId }) => messageId === message.id).at(-1);
              const failure =
                turn?.failure === null || turn?.failure === undefined
                  ? null
                  : failures[turn.failure];
              return (
                <li
                  key={message.id}
                  className={`planning-message planning-message-${message.role}`}
                >
                  <article aria-label={message.role === "user" ? "Your message" : "Kestrel reply"}>
                    <header>
                      <strong>{message.role === "user" ? "You" : "Kestrel"}</strong>
                      <time dateTime={message.createdAt}>
                        {new Date(message.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </header>
                    <div className="planning-message-content">{message.content}</div>
                    <SkillProvenance
                      skills={turn?.skills ?? []}
                      onAuthenticationError={onAuthenticationError}
                    />
                  </article>
                  {message.role !== "user" ||
                  turn === undefined ||
                  turn.state === "completed" ? null : (
                    <div className="planning-turn-state" role="status">
                      <strong>
                        {pendingTurn(turn)
                          ? turn.state === "queued"
                            ? "Waiting to start"
                            : "Kestrel is thinking"
                          : (failure?.title ?? "Planning stopped")}
                      </strong>
                      <p>
                        {pendingTurn(turn)
                          ? "You can leave this page. Planning continues while the workstation is running."
                          : failure?.detail}
                      </p>
                      {turn.question === null ? null : (
                        <blockquote className="planning-question">{turn.question}</blockquote>
                      )}
                      {turn.id !== latestTurn?.id ? null : (
                        <div className="planning-turn-actions">
                          {pendingTurn(turn) ? (
                            <Button
                              variant="outline"
                              disabled={
                                !online || !editable || commandPending || commandError !== null
                              }
                              onClick={() => void runAttempt({ kind: "cancel", turnId: turn.id })}
                            >
                              <Square aria-hidden="true" />
                              Stop planning
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              disabled={
                                !online || !editable || commandPending || commandError !== null
                              }
                              onClick={() =>
                                void runAttempt({
                                  kind: "retry",
                                  turnId: turn.id,
                                  requestId: crypto.randomUUID(),
                                })
                              }
                            >
                              Retry planning
                            </Button>
                          )}
                          {turn.failure === "authentication" ||
                          turn.failure === "unavailable" ||
                          turn.failure === "source_unavailable" ? (
                            <a
                              href={`/settings?projectId=${projectId}#${turn.failure === "source_unavailable" ? "repository-settings-title" : "codex-connection-title"}`}
                            >
                              {turn.failure === "source_unavailable"
                                ? "Check Project source"
                                : "Check connection"}
                            </a>
                          ) : null}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          {commandError === null ? null : (
            <div className="planning-command-error" role="alert">
              <p>{commandError}</p>
              <Button
                variant="outline"
                disabled={!online || commandPending}
                onClick={() => void runAttempt()}
              >
                {attemptKind === "send"
                  ? "Retry send"
                  : attemptKind === "cancel"
                    ? "Retry stop"
                    : "Retry request"}
              </Button>
            </div>
          )}
          <form className="planning-composer" onSubmit={submit}>
            <Label htmlFor="planning-message">Message</Label>
            <Textarea
              id="planning-message"
              rows={3}
              maxLength={16_000}
              value={draft}
              disabled={
                !online ||
                !editable ||
                commandPending ||
                activeTurn !== undefined ||
                commandError !== null
              }
              onChange={(event) => setDraft(event.currentTarget.value)}
              placeholder="Describe the change or answer Kestrel’s question…"
              aria-describedby="planning-message-help"
            />
            <div className="planning-composer-footer">
              <p id="planning-message-help">
                {editable
                  ? "Planning only. Implementation starts after you approve a plan."
                  : "This conversation is read-only. Its saved messages remain available."}
              </p>
              <Button
                type="submit"
                disabled={
                  !online ||
                  !editable ||
                  commandPending ||
                  activeTurn !== undefined ||
                  commandError !== null ||
                  draft.trim() === ""
                }
              >
                <Send aria-hidden="true" />
                {commandPending && attemptKind === "send" ? "Sending…" : "Send message"}
              </Button>
            </div>
          </form>
        </TabsContent>
        <TabsContent value="plan" forceMount className="data-[state=inactive]:hidden">
          <FeaturePlanPanel
            {...(chat.skills === undefined ? {} : { skillSelectionVersion: chat.skills.version })}
            projectId={projectId}
            featureId={featureId}
            online={online}
            visible={view === "plan"}
            conversationPending={activeTurn !== undefined}
            importsRevision={importsRevision}
            onAuthenticationError={onAuthenticationError}
            onChanged={() => void refresh()}
            onApproved={() => selectView("board")}
            onDirtyChange={onPlanDirtyChange}
          />
        </TabsContent>
        <TabsContent value="board">
          <FeatureBoardPanel
            projectId={projectId}
            featureId={featureId}
            online={online}
            onAuthenticationError={onAuthenticationError}
            onViewPlan={() => selectView("plan")}
          />
        </TabsContent>
      </Tabs>
    </section>
  );
}
