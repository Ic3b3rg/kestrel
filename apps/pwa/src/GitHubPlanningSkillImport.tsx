import { useContext, useEffect, useId, useRef, useState } from "react";
import {
  PreviewGitHubPlanningSkillCommandSchema,
  type GitHubPlanningSkillBundle,
  type InstallGitHubPlanningSkillCommand,
} from "@kestrel/contracts";
import { ApiClientError } from "./api.js";
import { planningRequestError } from "./FeatureNavigation.js";
import {
  installGitHubPlanningSkill,
  previewGitHubPlanningSkill,
} from "./factory-github-skills-api.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Label } from "./components/ui/label.js";
import { NativeSelect } from "./components/ui/native-select.js";
import { WorkspaceSuspendedContext } from "./components/ui/workspace-suspension.js";

export interface GitHubPlanningSkillImportProps {
  online: boolean;
  onInstalled: (bundle: GitHubPlanningSkillBundle) => void;
  onAuthenticationError: (error: unknown) => boolean;
}

export function GitHubPlanningSkillImport({
  online,
  onInstalled,
  onAuthenticationError,
}: GitHubPlanningSkillImportProps) {
  const id = useId();
  const suspended = useContext(WorkspaceSuspendedContext);
  const active = online && !suspended;
  const [kind, setKind] = useState<"starter" | "github">("starter");
  const [fields, setFields] = useState({
    owner: "",
    repository: "",
    path: "SKILL.md",
    ref: "main",
  });
  const [preview, setPreview] = useState<GitHubPlanningSkillBundle | null>(null);
  const [filePath, setFilePath] = useState("SKILL.md");
  const [previewing, setPreviewing] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const installRequest = useRef<AbortController | null>(null);
  const pendingInstall = useRef<InstallGitHubPlanningSkillCommand | null>(null);
  useEffect(
    () => () => {
      previewRequest.current?.abort();
      installRequest.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!active) {
      previewRequest.current?.abort();
      previewRequest.current = null;
      setPreviewing(false);
    }
  }, [active]);
  const locked = installing || pendingInstall.current !== null;
  const resetPreview = () => {
    previewRequest.current?.abort();
    previewRequest.current = null;
    setPreviewing(false);
    setPreview(null);
    setInstalled(false);
    setError(null);
  };
  const inspect = async () => {
    if (!active || locked || previewRequest.current !== null) return;
    const command = PreviewGitHubPlanningSkillCommandSchema.safeParse(
      kind === "starter"
        ? { kind, starter: "grilling-starter" }
        : {
            kind,
            owner: fields.owner.trim(),
            repository: fields.repository.trim(),
            path: fields.path.trim(),
            ref: fields.ref.trim(),
          },
    );
    if (!command.success) {
      setError("Enter a GitHub owner, repository, relative SKILL.md path and explicit ref.");
      return;
    }
    const request = new AbortController();
    previewRequest.current = request;
    setPreviewing(true);
    setPreview(null);
    setInstalled(false);
    setError(null);
    try {
      const bundle = await previewGitHubPlanningSkill(command.data, request.signal);
      if (request.signal.aborted) return;
      setPreview(bundle);
      setFilePath("SKILL.md");
    } catch (failure) {
      if (!request.signal.aborted && !onAuthenticationError(failure))
        setError(
          planningRequestError(
            failure,
            "The GitHub Skill could not be previewed. Check its source and try again.",
          ),
        );
    } finally {
      if (previewRequest.current === request) {
        previewRequest.current = null;
        if (!request.signal.aborted) setPreviewing(false);
      }
    }
  };
  const install = async () => {
    if (!active || installed || preview === null || installRequest.current !== null) return;
    pendingInstall.current ??= { requestId: crypto.randomUUID(), digest: preview.contentDigest };
    const request = new AbortController();
    installRequest.current = request;
    setInstalling(true);
    setError(null);
    let result: GitHubPlanningSkillBundle | null = null;
    try {
      const bundle = await installGitHubPlanningSkill(pendingInstall.current, request.signal);
      if (request.signal.aborted) return;
      pendingInstall.current = null;
      setInstalled(true);
      result = bundle;
    } catch (failure) {
      if (request.signal.aborted) return;
      if (
        failure instanceof ApiClientError &&
        failure.status >= 400 &&
        failure.status < 500 &&
        failure.status !== 408
      )
        pendingInstall.current = null;
      if (!onAuthenticationError(failure))
        setError(
          planningRequestError(
            failure,
            "Installation could not be confirmed. Retry installation to check the same request.",
          ),
        );
    } finally {
      installRequest.current = null;
      if (!request.signal.aborted) setInstalling(false);
    }
    if (result !== null) onInstalled(result);
  };
  const file = preview?.files.find(({ path }) => path === filePath) ?? preview?.files[0];
  return (
    <section className="grid min-w-0 gap-4 rounded-lg border p-4" aria-labelledby={`${id}-title`}>
      <div>
        <h3 id={`${id}-title`} className="font-semibold">
          Import from GitHub
        </h3>
        <p className="text-sm text-muted-foreground">
          Preview the instructions and source, then install the version you reviewed.
        </p>
      </div>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void inspect();
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-kind`}>Source</Label>
          <NativeSelect
            id={`${id}-kind`}
            value={kind}
            disabled={!active || locked}
            onChange={(event) => {
              resetPreview();
              setKind(event.currentTarget.value === "github" ? "github" : "starter");
            }}
          >
            <option value="starter">Grilling starter</option>
            <option value="github">GitHub Skill path</option>
          </NativeSelect>
        </div>
        {kind === "starter" ? (
          <p className="text-sm text-muted-foreground">
            A fixed set of Matt Pocock’s procedures for questions grounded in Project documents,
            specifications and ordered Work Items. The preview includes the original sources,
            license and Kestrel adaptation.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ["owner", "Owner"],
                ["repository", "Repository"],
                ["path", "Skill entry path"],
                ["ref", "Ref"],
              ] as const
            ).map(([field, label]) => (
              <div className="grid min-w-0 gap-1.5" key={field}>
                <Label htmlFor={`${id}-${field}`}>{label}</Label>
                <Input
                  id={`${id}-${field}`}
                  value={fields[field]}
                  required
                  disabled={!active || locked}
                  maxLength={
                    field === "owner"
                      ? 39
                      : field === "repository"
                        ? 100
                        : field === "path"
                          ? 512
                          : 255
                  }
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    resetPreview();
                    setFields((current) => ({ ...current, [field]: value }));
                  }}
                />
              </div>
            ))}
          </div>
        )}
        <Button
          type="submit"
          variant="outline"
          className="justify-self-start"
          disabled={!active || locked || previewing}
        >
          {previewing ? "Loading preview…" : "Preview Skill"}
        </Button>
      </form>
      {!online ? (
        <p role="status" className="text-sm">
          Reconnect to preview or install a Skill.
        </p>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {preview === null ? null : (
        <div className="grid min-w-0 gap-3">
          <div>
            <h4 className="font-medium">${preview.name}</h4>
            <p className="text-sm text-muted-foreground">{preview.description}</p>
          </div>
          <dl className="grid min-w-0 gap-2 text-sm">
            <div>
              <dt className="font-medium">Repository</dt>
              <dd className="break-all">
                {preview.source.owner}/{preview.source.repository}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Skill entry</dt>
              <dd className="break-all">{preview.source.path}</dd>
            </div>
            <div>
              <dt className="font-medium">Requested ref</dt>
              <dd className="break-all">{preview.source.requestedRef}</dd>
            </div>
            <div>
              <dt className="font-medium">Resolved commit</dt>
              <dd className="break-all font-mono text-xs">{preview.source.commitId}</dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            Retained version{" "}
            <code title={preview.contentDigest}>{preview.contentDigest.slice(0, 12)}</code> ·{" "}
            {preview.files.length} files
          </p>
          <Label htmlFor={`${id}-file`}>Instructions and references</Label>
          <NativeSelect
            id={`${id}-file`}
            value={file?.path ?? "SKILL.md"}
            onChange={(event) => setFilePath(event.currentTarget.value)}
          >
            {preview.files.map(({ path }) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
          </NativeSelect>
          <pre
            aria-label="Previewed Skill instructions"
            className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-3 text-sm"
          >
            {file?.content}
          </pre>
          <p className="text-xs text-muted-foreground">
            After installation, select this Skill in the planning session. Plans still require your
            approval.
          </p>
          <Button
            type="button"
            className="justify-self-start"
            disabled={!active || installing || installed}
            onClick={() => void install()}
          >
            {installing
              ? "Installing…"
              : installed
                ? "Installed"
                : pendingInstall.current !== null
                  ? "Retry installation"
                  : "Install reviewed version"}
          </Button>
        </div>
      )}
    </section>
  );
}
