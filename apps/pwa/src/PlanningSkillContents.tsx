import { useState } from "react";
import type { PlanningSkillBundle } from "@kestrel/contracts";

import { Label } from "./components/ui/label.js";
import { NativeSelect } from "./components/ui/native-select.js";

export function PlanningSkillContents({ bundle }: { bundle: PlanningSkillBundle }) {
  const [path, setPath] = useState("SKILL.md");
  const file = bundle.files.find((entry) => entry.path === path) ?? bundle.files[0];
  return (
    <div className="grid min-w-0 gap-4">
      <div>
        <h3 className="font-medium">${bundle.name}</h3>
        <p className="text-sm text-muted-foreground">{bundle.description}</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Imported from {bundle.source.label} · retained version{" "}
        <code title={bundle.contentDigest}>{bundle.contentDigest.slice(0, 12)}</code>
      </p>
      {bundle.source.kind === "github" ? (
        <dl className="grid min-w-0 gap-2 text-xs text-muted-foreground">
          <div>
            <dt className="font-medium">Skill entry</dt>
            <dd className="break-all">{bundle.source.path}</dd>
          </div>
          <div>
            <dt className="font-medium">Requested ref</dt>
            <dd className="break-all">{bundle.source.requestedRef}</dd>
          </div>
          <div>
            <dt className="font-medium">Resolved commit</dt>
            <dd className="break-all font-mono">{bundle.source.commitId}</dd>
          </div>
        </dl>
      ) : null}
      <Label htmlFor="skill-reference">Instructions and references</Label>
      <NativeSelect
        id="skill-reference"
        value={file?.path ?? "SKILL.md"}
        onChange={(event) => setPath(event.currentTarget.value)}
      >
        {bundle.files.map((entry) => (
          <option key={entry.path} value={entry.path}>
            {entry.path}
          </option>
        ))}
      </NativeSelect>
      <pre
        tabIndex={0}
        aria-label="Retained Skill instructions"
        className="max-h-[45dvh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-4 text-sm leading-relaxed"
      >
        {file?.content}
      </pre>
      <p className="text-xs text-muted-foreground">
        Kestrel uses these procedures for planning. Proposed documents and issues stay in the plan
        until you approve it.
      </p>
    </div>
  );
}
