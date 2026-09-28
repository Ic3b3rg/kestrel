import { useEffect, useState } from "react";
import { Popover } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import type { PlanningSkillSummary } from "@kestrel/contracts";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { fetchPlanningSkillCatalog } from "./factory-skills-api.js";
import { FormFeedback } from "./components/FormFeedback.js";

function collection(skill: PlanningSkillSummary) {
  if (skill.source.kind === "host") return skill.source.label;
  if (skill.source.owner === "mattpocock") return "Matt Pocock";
  if (skill.source.owner === "obra" && skill.source.repository === "superpowers")
    return "Superpowers";
  return `${skill.source.owner}/${skill.source.repository}`;
}

export function InterviewSkillPicker({
  skills,
  online,
  disabled,
  onSelect,
  onAuthenticationError,
}: {
  skills: PlanningSkillSummary[];
  online: boolean;
  disabled: boolean;
  onSelect: (skill: PlanningSkillSummary) => void;
  onAuthenticationError: (error: unknown) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<PlanningSkillSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !online) return;
    const controller = new AbortController();
    setError(null);
    void fetchPlanningSkillCatalog(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setCatalog(result.skills);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && !onAuthenticationError(failure))
          setError("Skills could not be loaded. Close and reopen to retry.");
      });
    return () => controller.abort();
  }, [open, online, onAuthenticationError]);
  const choices = (catalog ?? []).filter((skill) =>
    `${skill.name} ${collection(skill)}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Popover.Root
      open={open && !disabled}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) setQuery("");
      }}
    >
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="max-w-full rounded-full"
          disabled={disabled || !online}
          aria-label="Choose interview skill"
        >
          <span className="truncate">
            {skills.map((skill) => skill.name).join(", ") || "Choose skill"}
          </span>
          <ChevronDown aria-hidden="true" className="size-3" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 w-70 max-w-[calc(100vw-24px)] rounded-lg border bg-popover p-2 text-popover-foreground shadow-md"
          aria-label="Interview skill"
        >
          <Input
            aria-label="Search skills or collections"
            placeholder="Search skills or collections…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="my-2 max-h-60 overflow-y-auto" aria-label="Available skills">
            {catalog === null && error === null ? (
              <p className="p-2 text-sm">Loading skills…</p>
            ) : null}
            {catalog !== null && choices.length === 0 ? (
              <p className="p-2 text-sm">No matching skills.</p>
            ) : null}
            {choices.map((skill) => (
              <Button
                key={skill.contentDigest}
                type="button"
                variant="ghost"
                className="h-auto w-full justify-start gap-2 p-2 text-left"
                onClick={() => {
                  onSelect(skill);
                  setOpen(false);
                  setQuery("");
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{skill.name}</span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    {collection(skill)}
                  </span>
                </span>
                {skills.some((selected) => selected.contentDigest === skill.contentDigest) ? (
                  <Check aria-label="Selected" className="size-4" />
                ) : null}
              </Button>
            ))}
          </div>
          {error === null ? null : <FormFeedback kind="error">{error}</FormFeedback>}
          <a href="/settings/skills" className="block border-t p-2 text-sm underline">
            Manage skills
          </a>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
