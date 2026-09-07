import { useEffect, useRef, useState, type MouseEvent, type SyntheticEvent } from "react";
import { MessageSquare, Plus } from "lucide-react";
import type { CreateFeatureCommand, Feature } from "@kestrel/contracts";

import { ApiClientError, createFeature, fetchFeatures } from "./api.js";
import { appPath, type AppRoute } from "./app-route.js";
import { Button } from "./components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog.js";
import { Input } from "./components/ui/input.js";
import { Label } from "./components/ui/label.js";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./components/ui/sidebar.js";

type NavigableRoute = Exclude<AppRoute, { kind: "not_found" }>;

export function planningRequestError(error: unknown, fallback: string): string {
  return error instanceof ApiClientError
    ? `${error.details.message} Reference: ${error.details.correlationId}`
    : fallback;
}

export function handleFeatureLink(
  event: MouseEvent<HTMLAnchorElement>,
  route: NavigableRoute,
  onNavigate: (route: NavigableRoute) => void,
): void {
  if (
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.currentTarget.target === "_blank"
  )
    return;
  event.preventDefault();
  onNavigate(route);
}

function NewFeatureButton({
  projectId,
  online,
  onCreated,
  onAuthenticationError,
}: {
  projectId: string;
  online: boolean;
  onCreated: (feature: Feature) => void;
  onAuthenticationError: (error: unknown) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const command = useRef<CreateFeatureCommand | null>(null);
  const completed = useRef<Feature | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!online || pending || title.trim() === "") return;
    command.current ??= { requestId: crypto.randomUUID(), title: title.trim() };
    setPending(true);
    setError(null);
    try {
      // An accepted command belongs to the workstation, even if this view closes.
      const feature = await createFeature(projectId, command.current);
      if (!alive.current) return;
      completed.current = feature;
      command.current = null;
      setTitle("");
      setOpen(false);
    } catch (failure) {
      if (alive.current && !onAuthenticationError(failure))
        setError(
          planningRequestError(
            failure,
            "Kestrel could not confirm creation. Retry to check the same request.",
          ),
        );
    } finally {
      if (alive.current) setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) setOpen(next);
      }}
    >
      <Button
        ref={trigger}
        variant="outline"
        className="w-full justify-start"
        disabled={!online}
        onClick={() => setOpen(true)}
      >
        <Plus aria-hidden="true" />
        New feature
      </Button>
      <DialogContent
        showCloseButton={!pending}
        className="sm:max-w-md"
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          trigger.current?.focus();
          const feature = completed.current;
          completed.current = null;
          if (feature !== null) onCreated(feature);
        }}
      >
        <DialogTitle>New feature</DialogTitle>
        <DialogDescription>
          Name the outcome you want. You will shape its scope and requirements in the chat.
        </DialogDescription>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="new-feature-name">Feature name</Label>
            <Input
              id="new-feature-name"
              value={title}
              maxLength={160}
              required
              disabled={pending || error !== null}
              onChange={(event) => setTitle(event.currentTarget.value)}
              placeholder="For example, search saved reports"
            />
          </div>
          {error === null ? null : (
            <p role="alert" className="planning-error">
              {error}
            </p>
          )}
          <Button type="submit" disabled={!online || pending || title.trim() === ""}>
            {pending ? "Creating…" : error === null ? "Create feature" : "Retry creation"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function FeatureNavigation({
  projectId,
  selectedFeatureId,
  online,
  onNavigate,
  onAuthenticationError,
}: {
  projectId: string;
  selectedFeatureId?: string;
  online: boolean;
  onNavigate: (route: NavigableRoute) => void;
  onAuthenticationError: (error: unknown) => boolean;
}) {
  const [features, setFeatures] = useState<Feature[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!online) {
      setFeatures([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchFeatures(projectId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setFeatures(result.features);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && !onAuthenticationError(failure))
          setError(
            planningRequestError(failure, "Feature chats could not be loaded. Refresh to retry."),
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, selectedFeatureId, online, generation, onAuthenticationError]);

  return (
    <nav aria-label="Feature chats">
      <SidebarGroup className="gap-2">
        <SidebarGroupLabel>Features</SidebarGroupLabel>
        <NewFeatureButton
          projectId={projectId}
          online={online}
          onAuthenticationError={onAuthenticationError}
          onCreated={(feature) => {
            setFeatures((current) =>
              current.some(({ id }) => id === feature.id) ? current : [...current, feature],
            );
            onNavigate({ kind: "feature", projectId: feature.projectId, featureId: feature.id });
          }}
        />
        {!online ? (
          <p className="project-rail-state">Reconnect to view feature chats.</p>
        ) : loading && features.length === 0 ? (
          <p className="project-rail-state" role="status">
            Loading feature chats…
          </p>
        ) : error !== null ? (
          <div className="project-rail-state" role="alert">
            <p>{error}</p>
            <Button variant="outline" onClick={() => setGeneration((current) => current + 1)}>
              Refresh chats
            </Button>
          </div>
        ) : features.length === 0 ? (
          <p className="project-rail-state">Start a feature to plan it here.</p>
        ) : null}
        <SidebarMenu>
          {features.map((feature) => {
            const route = { kind: "feature" as const, projectId, featureId: feature.id };
            return (
              <SidebarMenuItem key={feature.id}>
                <SidebarMenuButton
                  asChild
                  isActive={feature.id === selectedFeatureId}
                  className="h-auto min-h-10 py-2"
                >
                  <a
                    href={appPath(route)}
                    aria-current={feature.id === selectedFeatureId ? "page" : undefined}
                    onClick={(event) => handleFeatureLink(event, route, onNavigate)}
                  >
                    <MessageSquare aria-hidden="true" />
                    <span className="truncate">{feature.title}</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroup>
    </nav>
  );
}
