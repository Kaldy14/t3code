import { Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useEffect } from "react";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import ThreadSidebar from "../components/Sidebar";
import { Sidebar, SidebarProvider } from "~/components/ui/sidebar";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { projectTerminalThreadId } from "../types";

const ProjectTerminalDrawer = lazy(() => import("../components/ProjectTerminalDrawer"));

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

  return (
    <SidebarProvider defaultOpen>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
      >
        <ThreadSidebar />
      </Sidebar>
      <DiffWorkerPoolProvider>
        <Outlet />
        <ProjectTerminalDrawers />
      </DiffWorkerPoolProvider>
    </SidebarProvider>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
