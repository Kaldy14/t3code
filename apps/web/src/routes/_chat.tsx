import { Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import ThreadSidebar from "../components/Sidebar";
import { Sidebar, SidebarProvider } from "~/components/ui/sidebar";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { projectTerminalThreadId } from "../types";
import { isThreadSearchShortcut } from "../keybindings";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";

const ProjectTerminalDrawer = lazy(() => import("../components/ProjectTerminalDrawer"));
const ThreadSearchDialog = lazy(() => import("../components/ThreadSearchDialog"));

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

function ProjectTerminalDrawers() {
  const projects = useStore((s) => s.projects);
  const terminalStateByThreadId = useTerminalStateStore((s) => s.terminalStateByThreadId);
  const setTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const setTerminalHeight = useTerminalStateStore((s) => s.setTerminalHeight);

  const openProjectTerminals = projects.filter((project) => {
    const syntheticId = projectTerminalThreadId(project.id);
    const state = terminalStateByThreadId[syntheticId];
    return state?.terminalOpen === true;
  });

  if (openProjectTerminals.length === 0) return null;

  return (
    <Suspense fallback={null}>
      {openProjectTerminals.map((project) => {
        const syntheticId = projectTerminalThreadId(project.id);
        const state = terminalStateByThreadId[syntheticId];
        return (
          <ProjectTerminalDrawer
            key={project.id}
            projectId={project.id}
            cwd={project.cwd}
            height={state?.terminalHeight ?? 280}
            onHeightChange={(height) => setTerminalHeight(syntheticId, height)}
            onClose={() => setTerminalOpen(syntheticId, false)}
          />
        );
      })}
    </Suspense>
  );
}

function ChatRouteLayout() {
  const navigate = useNavigate();
  const [searchOpen, setSearchOpen] = useState(false);
  const { data: keybindings = EMPTY_KEYBINDINGS } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isThreadSearchShortcut(event, keybindings)) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);

  const handleSearchClick = useCallback(() => setSearchOpen(true), []);

  return (
    <SidebarProvider defaultOpen>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
      >
        <ThreadSidebar onSearchClick={handleSearchClick} />
      </Sidebar>
      <DiffWorkerPoolProvider>
        <div className="flex h-dvh min-h-0 w-full flex-col">
          <div className="flex min-h-0 flex-1">
            <Outlet />
          </div>
          <ProjectTerminalDrawers />
        </div>
      </DiffWorkerPoolProvider>
      <Suspense fallback={null}>
        <ThreadSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      </Suspense>
    </SidebarProvider>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
