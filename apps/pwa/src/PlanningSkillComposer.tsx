import { cn } from "cn";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { PlanningSkillSummary } from "@kestrel/contracts";
import { Textarea } from "./components/ui/textarea.js";
import { FormFeedback } from "./components/FormFeedback.js";
import { planningRequestError } from "./FeatureNavigation.js";
import { fetchPlanningSkillCatalog } from "./factory-skills-api.js";
import {
  findSlashSkillQuery,
  insertSlashSkill,
  type SlashSkillQuery,
} from "./planning-skill-picker.js";

export interface PlanningSkillComposerProps {
  id: string;
  value: string;
  onValueChange: (text: string) => void;
  online: boolean;
  disabled: boolean;
  onAuthenticationError: (error: unknown) => boolean;
  rows: number;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  name?: string;
  maxLength?: number;
  placeholder?: string;
  className?: string;
  describedBy?: string;
  autoFocus?: boolean;
}

export function PlanningSkillComposer({
  id,
  value,
  onValueChange,
  online,
  disabled,
  onAuthenticationError,
  rows,
  textareaRef,
  onKeyDown,
  name,
  maxLength,
  placeholder,
  className,
  describedBy,
  autoFocus,
}: PlanningSkillComposerProps) {
  const listId = useId();
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const [catalog, setCatalog] = useState<PlanningSkillSummary[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState<SlashSkillQuery | null>(null);
  const [active, setActive] = useState(0);
  const searching = query !== null;
  const hasReferences = /(?:^|\s)[/$][a-z0-9-]+/u.test(value);

  useEffect(() => {
    if (!online || (!searching && !hasReferences) || catalogLoaded) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchPlanningSkillCatalog(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setCatalog(result.skills);
          setCatalogLoaded(true);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && !onAuthenticationError(failure))
          setError(planningRequestError(failure, "Installed Skills could not be loaded."));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [online, onAuthenticationError, searching, hasReferences, catalogLoaded]);

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    localRef.current?.focus();
    localRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [value]);

  const updateQuery = (text: string, caret: number) => {
    setQuery(findSlashSkillQuery(text, caret));
    setActive(0);
  };
  const matches =
    query === null ? [] : catalog.filter((skill) => skill.name.startsWith(query.query));
  const open = online && !disabled && query !== null;
  const choose = (skill: PlanningSkillSummary) => {
    if (query === null) return;
    const result = insertSlashSkill(value, query, skill.name);
    pendingCaret.current = result.caret;
    onValueChange(result.text);
    setQuery(null);
  };

  const highlighted: ReactNode[] = [];
  let previous = 0;
  for (const match of value.matchAll(/(?:^|\s)([/$]([a-z0-9][a-z0-9-]{0,63}))(?=\s|$|[.,!?])/gu)) {
    const token = match[1];
    if (token === undefined || !catalog.some((skill) => skill.name === match[2])) continue;
    const start = match.index + match[0].length - token.length;
    highlighted.push(
      value.slice(previous, start),
      <mark
        key={start}
        className="rounded-sm bg-primary/15 text-transparent outline-1 outline-primary/40"
      >
        {token}
      </mark>,
    );
    previous = start + token.length;
  }
  highlighted.push(value.slice(previous));
  return (
    <div className="relative min-w-0">
      <div className="relative">
        <div
          ref={highlightRef}
          data-skill-highlight
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words rounded-lg border border-transparent px-2.5 py-2 text-base text-transparent md:text-sm",
            className,
          )}
        >
          {highlighted}
          {"\n"}
        </div>
        <Textarea
          ref={(node) => {
            localRef.current = node;
            if (textareaRef !== undefined) textareaRef.current = node;
          }}
          id={id}
          name={name}
          rows={rows}
          maxLength={maxLength}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          className={`relative ${className ?? ""}`}
          spellCheck={false}
          onScroll={(event) => {
            if (highlightRef.current !== null) {
              highlightRef.current.scrollTop = event.currentTarget.scrollTop;
              highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
            }
          }}
          aria-describedby={describedBy}
          autoFocus={autoFocus}
          aria-autocomplete="list"
          aria-controls={open && matches.length > 0 ? listId : undefined}
          aria-activedescendant={
            open && matches.length > 0 ? `${listId}-${String(active)}` : undefined
          }
          onChange={(event) => {
            onValueChange(event.currentTarget.value);
            updateQuery(event.currentTarget.value, event.currentTarget.selectionStart);
          }}
          onClick={(event) => updateQuery(value, event.currentTarget.selectionStart)}
          onKeyUp={(event) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              updateQuery(value, event.currentTarget.selectionStart);
          }}
          onKeyDown={(event) => {
            if (open && !event.ctrlKey && !event.metaKey && !event.altKey) {
              if (event.key === "ArrowDown" && matches.length > 0) {
                event.preventDefault();
                setActive((index) => (index + 1) % matches.length);
                return;
              }
              if (event.key === "ArrowUp" && matches.length > 0) {
                event.preventDefault();
                setActive((index) => (index - 1 + matches.length) % matches.length);
                return;
              }
              if (
                event.key === "Enter" &&
                matches[active] !== undefined &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                choose(matches[active]);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setQuery(null);
                return;
              }
            }
            onKeyDown?.(event);
          }}
        />
      </div>
      {open ? (
        <div className="mt-2 grid max-h-56 gap-1 overflow-y-auto rounded-md border bg-popover p-2 text-sm shadow-md">
          {loading ? <FormFeedback kind="pending">Loading installed Skills…</FormFeedback> : null}
          {error !== null ? (
            <FormFeedback kind="error">
              {error}{" "}
              <a className="underline" href="/settings/skills">
                Open Settings → Skills
              </a>
            </FormFeedback>
          ) : null}
          {!loading && error === null && matches.length === 0 ? (
            <p className="px-2 py-1 text-muted-foreground">
              No matching installed Skills.{" "}
              <a className="underline" href="/settings/skills">
                Open Settings → Skills
              </a>
            </p>
          ) : null}
          {matches.length > 0 ? (
            <div
              id={listId}
              role="listbox"
              aria-label="Installed Skills matching slash command"
              className="grid gap-1"
            >
              {matches.map((skill, index) => (
                <button
                  key={skill.contentDigest}
                  id={`${listId}-${String(index)}`}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className="grid min-w-0 rounded-sm px-2 py-1 text-left hover:bg-accent aria-selected:bg-accent"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(skill)}
                >
                  <span className="font-medium">/{skill.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {skill.description}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
