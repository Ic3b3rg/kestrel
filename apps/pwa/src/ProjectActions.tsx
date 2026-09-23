import { FormFeedback } from "./components/FormFeedback.js";
import { ApiClientError } from "./api.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Label } from "./components/ui/label.js";
import { useId, useRef, useState, type SyntheticEvent } from "react";
import {
  OpenPublicGitHubPullRequestCommandSchema,
  type ProjectInbox,
  type PublicGitHubPullRequestUrl,
  type ReviewRevisionAvailable,
} from "@kestrel/contracts";
import { OpenLocalRepositoryForm } from "./OpenLocalRepositoryForm.js";

type Project = ProjectInbox["projects"][number];
export function ProjectActions({
  project,
  repository,
  disabled,
  onOpen,
  onAvailable,
  onAuthenticationError,
}: {
  project: Project;
  repository: { owner: string; name: string } | null;
  disabled: boolean;
  onOpen: (url: PublicGitHubPullRequestUrl) => void | Promise<void>;
  onAvailable: (result: ReviewRevisionAvailable) => void;
  onAuthenticationError?: (error: unknown) => boolean;
}) {
  const id = useId();
  const active = useRef(false);
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
    event.preventDefault();
    if (disabled || active.current) return;
    const parsed = OpenPublicGitHubPullRequestCommandSchema.safeParse({ url });
    if (!parsed.success) {
      setError(
        "Enter a canonical public pull request URL such as https://github.com/owner/repository/pull/123.",
      );
      return;
    }
    if (repository === null) {
      setError(
        "The selected Project's GitHub repository could not be verified. Check its connection in Settings first.",
      );
      return;
    }
    const [, owner, name] = new URL(parsed.data.url).pathname.split("/");
    if (
      owner?.toLowerCase() !== repository.owner.toLowerCase() ||
      name?.toLowerCase() !== repository.name.toLowerCase()
    ) {
      setError(
        `This URL belongs to a different repository. Enter a public PR from ${repository.owner}/${repository.name}.`,
      );
      return;
    }
    setError(null);
    active.current = true;
    setPending(true);
    setSuccess(false);
    try {
      await onOpen(parsed.data.url);
      setSuccess(true);
    } catch (failure) {
      if (!onAuthenticationError?.(failure))
        setError(
          failure instanceof ApiClientError
            ? failure.details.message
            : "The pull request could not be opened. Check the connection and retry this URL.",
        );
    } finally {
      active.current = false;
      setPending(false);
    }
  };
  return (
    <details className="project-menu">
      <summary>Project menu</summary>
      <div className="project-menu-content">
        {project.localRepositorySource?.state === "attached" ? (
          <OpenLocalRepositoryForm
            disabled={disabled || pending}
            projects={[project]}
            boundRepository={project.localRepositorySource}
            onAvailable={onAvailable}
            {...(onAuthenticationError === undefined ? {} : { onAuthenticationError })}
          />
        ) : (
          <p>Attach a local repository to compare committed refs.</p>
        )}
        <form className="project-url-form" onSubmit={(event) => void submit(event)} noValidate>
          <Label htmlFor={id}>Public GitHub pull request URL</Label>
          <Input
            id={id}
            type="url"
            value={url}
            disabled={disabled || pending}
            spellCheck={false}
            placeholder="https://github.com/owner/repository/pull/123"
            aria-invalid={error !== null}
            aria-describedby={`${id}-help${error === null ? "" : ` ${id}-error`}`}
            onChange={(event) => {
              setUrl(event.currentTarget.value);
              setError(null);
            }}
          />
          <Button type="submit" disabled={disabled || pending}>
            Open PR by URL
          </Button>
          <p id={`${id}-help`} className="form-help">
            Public PRs in this repository only. No GitHub credentials are sent or stored. Public
            access shares GitHub’s limit of 60 unauthenticated GitHub API requests per hour per
            Installation IP.
          </p>
          {pending ? (
            <FormFeedback kind="pending">Opening this pull request…</FormFeedback>
          ) : success ? (
            <FormFeedback kind="success">This pull request is open.</FormFeedback>
          ) : null}
          {error === null ? null : (
            <FormFeedback id={`${id}-error`} kind="error" focus>
              {error}
            </FormFeedback>
          )}
        </form>
        <a href={`/projects/${encodeURIComponent(project.id)}/settings`}>Project settings</a>
      </div>
    </details>
  );
}
