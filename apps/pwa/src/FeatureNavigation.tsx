import { useEffect, useState, type MouseEvent } from "react";
import { MessageSquare, Plus } from "lucide-react";
import type { Feature } from "@kestrel/contracts";

import { ApiClientError, fetchFeatures } from "./api.js";
import { appPath, type AppRoute } from "./app-route.js";
import { Button } from "./components/ui/button.js";
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const result = await fetchFeatures(projectId, controller.signal);
        if (controller.signal.aborted) return;
        setFeatures(result.features);
        timer = setTimeout(() => void read(), 2_000);
      } catch (failure) {
        if (!controller.signal.aborted && !onAuthenticationError(failure))
          setError(
            planningRequestError(failure, "Feature chats could not be loaded. Refresh to retry."),
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [projectId, selectedFeatureId, online, generation, onAuthenticationError]);

  return (
    <nav aria-label="Feature chats">
      <SidebarGroup className="gap-2">
        <SidebarGroupLabel>Features</SidebarGroupLabel>
        <Button
          variant="outline"
          className="w-full justify-start"
          disabled={!online}
          onClick={() =>
            onNavigate({ kind: "planning", projectId, requestId: crypto.randomUUID() })
          }
        >
          <Plus aria-hidden="true" /> Start plan
        </Button>
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
