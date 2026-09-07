import { NativeSelect } from "./components/ui/native-select.js";
import { Label } from "./components/ui/label.js";
import type { DirectApiProfile, ProjectInbox } from "@kestrel/contracts";
import { DirectApiProfilePanel } from "./DirectApiProfilePanel.js";
import { projectLabel } from "./AuthenticatedShell.js";

export function ProjectSettingsPanel({
  projects,
  projectId,
  onSelectProject,
  online,
  onAuthenticationError,
  onChanged,
}: {
  projects: ProjectInbox["projects"];
  projectId: string;
  onSelectProject: (projectId: string) => void;
  online: boolean;
  onAuthenticationError?: (error: unknown) => boolean;
  onChanged: (projectId: string, profile: DirectApiProfile) => void;
}) {
  const project = projects.find((candidate) => candidate.id === projectId);
  return (
    <section className="project-settings" aria-labelledby="project-settings-title">
      <h2 id="project-settings-title">Project settings</h2>
      <p>
        Direct API configuration belongs to the selected Project. Global host connections and Codex
        model defaults are managed separately above.
      </p>
      <Label htmlFor="settings-project">Project to configure</Label>
      <NativeSelect
        id="settings-project"
        value={project?.id ?? ""}
        disabled={!online}
        onChange={(event) => onSelectProject(event.currentTarget.value)}
      >
        <option value="">Choose a Project</option>
        {projects.map((candidate) => (
          <option value={candidate.id} key={candidate.id}>
            {projectLabel(candidate)}
          </option>
        ))}
      </NativeSelect>
      {project === undefined ? (
        <p>Select a Project to inspect its existing Direct API profile.</p>
      ) : (
        <>
          <h3>{projectLabel(project)}</h3>
          <a href={`/projects/${project.id}`}>Back to Project</a>
          <DirectApiProfilePanel
            key={project.id}
            projectId={project.id}
            disabled={!online}
            onChanged={(profile) => onChanged(project.id, profile)}
            {...(onAuthenticationError === undefined ? {} : { onAuthenticationError })}
          />
        </>
      )}
    </section>
  );
}
