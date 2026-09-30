import { useEffect, useState } from "react";
import { fetchBoardSettings, saveBoardSettings } from "./project-issue-api.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { planningRequestError } from "./FeatureNavigation.js";

export function ProjectBoardSettingsPanel({
  projectId,
  online,
  onAuthenticationError,
}: {
  projectId: string;
  online: boolean;
  onAuthenticationError?: ((error: unknown) => boolean) | undefined;
}) {
  const [label, setLabel] = useState("ready-for-agent");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetchBoardSettings(projectId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setLabel(value.readyLabel);
          setReady(true);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !onAuthenticationError?.(error))
          setMessage("Board settings could not be read.");
      });
    return () => controller.abort();
  }, [projectId, onAuthenticationError]);
  return (
    <section className="record-section space-y-3" aria-labelledby="board-settings-title">
      <h2 id="board-settings-title">Development from the board</h2>
      <p className="text-sm text-muted-foreground">
        Only open issues with this label can be started. Dropping one into In progress authorizes
        development; additional issues wait until the current work enters review.
      </p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          setMessage(null);
          void saveBoardSettings(projectId, label)
            .then((value) => {
              setLabel(value.readyLabel);
              setMessage("Board settings saved.");
            })
            .catch((error: unknown) => {
              if (!onAuthenticationError?.(error))
                setMessage(planningRequestError(error, "Board settings could not be saved."));
            })
            .finally(() => setSaving(false));
        }}
      >
        <label htmlFor="ready-issue-label">Ready label</label>
        <Input
          id="ready-issue-label"
          value={label}
          maxLength={100}
          required
          disabled={!ready || !online || saving}
          onChange={(event) => setLabel(event.target.value)}
        />
        <Button type="submit" disabled={!ready || !online || saving || label.trim() === ""}>
          {saving ? "Saving…" : "Save ready label"}
        </Button>
      </form>
      {message === null ? null : <p role="status">{message}</p>}
    </section>
  );
}
