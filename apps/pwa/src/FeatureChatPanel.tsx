import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { FileText, RefreshCw, Send, Square } from "lucide-react";
import type {
  Feature,
  FeatureChat,
  PlanningFailure,
  PlanningTurn,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog.js";
import { Label } from "./components/ui/label.js";
import { Textarea } from "./components/ui/textarea.js";

const failures: Record<PlanningFailure, { title: string; detail: string }> = {
  unavailable: {
    title: "Codex is unavailable",
    detail: "Your message is saved. Check the workstation connection, then retry planning.",
  },
  authentication: {
    title: "Sign in to Codex",
    detail: "Your message is saved. Restore the Codex connection in Settings, then retry planning.",
  },
  usage_limit: {
    title: "Codex usage limit reached",
    detail: "Your message is saved. Retry when usage is available again.",
  },
  permission_required: {
    title: "A permission decision is required",
    detail: "Planning stopped at a permission request. Review the question before continuing.",
  },
  input_required: {
    title: "Kestrel needs your answer",
    detail: "Answer the question in the chat to continue planning.",
  },
  timeout: {
    title: "Planning timed out",
    detail: "Your message is saved. Retry this turn when you are ready.",
  },
  cancelled: {
    title: "Planning stopped",
    detail: "Your saved message remains in this conversation.",
  },
  interrupted: {
    title: "Planning was interrupted",
    detail: "Your message is saved. Retry explicitly to continue.",
  },
  invalid_response: {
    title: "The reply could not be read",
    detail: "Kestrel could not save a valid answer. Retry this turn.",
  },
  source_unavailable: {
    title: "Project documents are unavailable",
    detail: "Check the Project source in Settings before retrying.",
  },
};

function pendingTurn(turn: PlanningTurn | undefined): boolean {
  return turn?.state === "queued" || turn?.state === "running";
}

function DocumentInspector({ context }: { context: FeatureChat["context"] }) {
  const [selectedPath, setSelectedPath] = useState("");
  const selected =
    context?.documents.find(({ path }) => path === selectedPath) ?? context?.documents[0];
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">
          <FileText aria-hidden="true" />
          Project documents
        </Button>
      </DialogTrigger>
      <DialogContent className="planning-documents-dialog max-h-[85dvh] overflow-y-auto sm:max-w-4xl">
        <DialogTitle>Project documents</DialogTitle>
        <DialogDescription>
          Committed Markdown read for this conversation. These documents remain unchanged by
          planning.
        </DialogDescription>
        {context?.notice === null || context?.notice === undefined ? null : (
          <p className="planning-notice">{context.notice}</p>
        )}
        {context?.commitId === null || context?.commitId === undefined ? null : (
          <p className="planning-source-commit">
            Source commit <code>{context.commitId}</code>
          </p>
        )}
        {context === null ? (
          <p>Documents will be read when you send the first message.</p>
        ) : context.documents.length === 0 ? (
          <p>No committed Markdown documents were available for this turn.</p>
        ) : (
          <div className="planning-documents-layout">
            <div className="planning-document-list" role="group" aria-label="Choose a document">
              {context.documents.map((document) => (
                <Button
                  key={document.path}
                  variant={document.path === selected?.path ? "secondary" : "ghost"}
                  className="justify-start whitespace-normal text-left"
                  aria-pressed={document.path === selected?.path}
                  onClick={() => setSelectedPath(document.path)}
                >
                  {document.path}
                </Button>
              ))}
            </div>
            {selected === undefined ? null : (
              <section className="planning-document" aria-label={selected.path}>
                <h3>{selected.path}</h3>
                <pre tabIndex={0} aria-label={`Contents of ${selected.path}`}>
                  {selected.content}
                </pre>
              </section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

type Attempt =
  | { kind: "send"; command: SendPlanningMessageCommand }
  | { kind: "retry"; turnId: string; requestId: string }
  | { kind: "cancel"; turnId: string };

export interface FeatureChatPanelProps {
  projectId: string;
  projectName: string;
  featureId: string;
  online: boolean;
  onNavigate: (route: Exclude<AppRoute, { kind: "not_found" }>) => void;
  onAuthenticationError: (error: unknown) => boolean;
  onFeatureRead: (feature: Feature) => void;
  onFeatureUnavailable: (projectId: string, featureId: string) => void;
  loadChat?: typeof fetchFeatureChat;
  sendMessage?: typeof sendPlanningMessage;
  retryTurn?: typeof retryPlanningTurn;
  cancelTurn?: typeof cancelPlanningTurn;
}

export function FeatureChatPanel({
  projectId,
  projectName,
  featureId,
  online,
  onNavigate,
  onAuthenticationError,
  onFeatureRead,
  onFeatureUnavailable,
  loadChat = fetchFeatureChat,
  sendMessage = sendPlanningMessage,
  retryTurn = retryPlanningTurn,
  cancelTurn = cancelPlanningTurn,
}: FeatureChatPanelProps) {
  const [chat, setChat] = useState<FeatureChat | null>(null);
  const [reading, setReading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
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
      if (result.feature.id !== featureId || result.feature.projectId !== projectId)
        throw new Error("The feature belongs to another Project");
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
    else {
      setChat(null);
      setReading(false);
    }
    return () => {
      alive.current = false;
      activeRead.current?.abort();
    };
  }, [online, refresh]);

  const latestTurn = chat?.turns.at(-1);
  const activeTurn = chat?.turns.find(pendingTurn);
  useEffect(() => {
    if (!online || activeTurn === undefined || readError !== null) return;
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
    if (draft.trim() === "" || commandError !== null || activeTurn !== undefined) return;
    void runAttempt({
      kind: "send",
      command: { requestId: crypto.randomUUID(), text: draft.trim() },
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
          <p>
            Planning <span aria-hidden="true">·</span> Define the outcome before implementation.
          </p>
        </div>
        <div className="feature-planning-actions">
          <DocumentInspector context={chat.context} />
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
      {readError === null ? null : (
        <p className="planning-error" role="alert">
          {readError}
        </p>
      )}
      {chat.context?.notice === null || chat.context?.notice === undefined ? null : (
        <p className="planning-notice">{chat.context.notice}</p>
      )}
      {chat.messages.length === 0 ? (
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
            turn?.failure === null || turn?.failure === undefined ? null : failures[turn.failure];
          return (
            <li key={message.id} className={`planning-message planning-message-${message.role}`}>
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
                          disabled={!online || commandPending || commandError !== null}
                          onClick={() => void runAttempt({ kind: "cancel", turnId: turn.id })}
                        >
                          <Square aria-hidden="true" />
                          Stop planning
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          disabled={!online || commandPending || commandError !== null}
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
          disabled={!online || commandPending || activeTurn !== undefined || commandError !== null}
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder="Describe the change or answer Kestrel’s question…"
          aria-describedby="planning-message-help"
        />
        <div className="planning-composer-footer">
          <p id="planning-message-help">
            Planning only. Implementation starts after you approve a plan.
          </p>
          <Button
            type="submit"
            disabled={
              !online ||
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
    </section>
  );
}
