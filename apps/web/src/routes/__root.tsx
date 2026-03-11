import { type OrchestrationSessionStatus, ThreadId } from "@t3tools/contracts";
import type { SessionPhase } from "../types";
import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";

import { APP_DISPLAY_NAME } from "../branding";
import { Button } from "../components/ui/button";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { preferredTerminalEditor } from "../terminal-links";
import { terminalRunningSubprocessFromEvent } from "../terminalActivity";
import { onServerConfigUpdated, onServerWelcome } from "../wsNativeApi";
import {
  dispatchActivityNotification,
  dispatchSessionSetNotification,
  requestNotificationPermission,
} from "../lib/notifications";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";

/** Lightweight mapping duplicating the store's toLegacySessionStatus so we can
 *  eagerly patch background-thread session status without a full snapshot sync. */
function toLegacySessionStatusFromOrchestration(
  status: OrchestrationSessionStatus,
): SessionPhase | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
  if (!readNativeApi()) {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            Connecting to {APP_DISPLAY_NAME} server...
          </p>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <EventRouter />
        <DesktopProjectBootstrap />
        <Outlet />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Something went wrong.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => reset()}>
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="group-open:hidden">Show error details</span>
            <span className="hidden group-open:inline">Hide error details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs text-foreground/85">
            {details}
          </pre>
        </details>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

function EventRouter() {
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const removeOrphanedTerminalStates = useTerminalStateStore(
    (store) => store.removeOrphanedTerminalStates,
  );
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const pathnameRef = useRef(pathname);
  const lastConfigIssuesSignatureRef = useRef<string | null>(null);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const deferredThreadIdsRef = useRef(new Set<string>());

  pathnameRef.current = pathname;

  useEffect(() => {
    requestNotificationPermission();
  }, []);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    let disposed = false;
    let latestSequence = 0;
    let syncing = false;
    let pending = false;
    let needsProviderInvalidation = false;
    const sessionStatusByThread = new Map<
      string,
      import("@t3tools/contracts").OrchestrationSessionStatus
    >();

    const flushSnapshotSync = async (): Promise<void> => {
      const snapshot = await api.orchestration.getSnapshot();
      if (disposed) return;
      latestSequence = Math.max(latestSequence, snapshot.snapshotSequence);
      syncServerReadModel(snapshot);
      const draftThreadIds = Object.keys(
        useComposerDraftStore.getState().draftThreadsByThreadId,
      ) as ThreadId[];
      const activeThreadIds = collectActiveTerminalThreadIds({
        snapshotThreads: snapshot.threads,
        draftThreadIds,
        projectIds: snapshot.projects.map((p) => p.id),
      });
      removeOrphanedTerminalStates(activeThreadIds);
      if (pending) {
        pending = false;
        await flushSnapshotSync();
      }
    };

    const syncSnapshot = async () => {
      if (syncing) {
        pending = true;
        return;
      }
      syncing = true;
      pending = false;
      try {
        await flushSnapshotSync();
      } catch {
        // Keep prior state and wait for next domain event to trigger a resync.
      }
      syncing = false;
    };

    const domainEventFlushThrottler = new Throttler(
      () => {
        if (needsProviderInvalidation) {
          needsProviderInvalidation = false;
          void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
        }
        void syncSnapshot();
      },
      {
        wait: 100,
        leading: false,
        trailing: true,
      },
    );

    const getCurrentThreadId = (): string | null => {
      const match = pathnameRef.current.match(/^\/([^/]+)/);
      return match?.[1] ?? null;
    };

    const unsubDomainEvent = api.orchestration.onDomainEvent((event) => {
      if (event.sequence <= latestSequence) {
        return;
      }
      latestSequence = event.sequence;

      // Determine if this event is for the currently viewed thread.
      const currentThreadId = getCurrentThreadId();
      const isProjectEvent = event.aggregateKind === "project";
      const isCurrentThread =
        event.aggregateKind === "thread" && event.aggregateId === currentThreadId;

      if (event.type === "thread.turn-diff-completed" || event.type === "thread.reverted") {
        needsProviderInvalidation = true;
      }

      // Always handle notifications regardless of which thread.
      if (event.type === "thread.activity-appended") {
        const threads = useStore.getState().threads;
        const thread = threads.find((t) => t.id === event.payload.threadId);
        const threadId = event.payload.threadId;
        dispatchActivityNotification(event.payload.activity, thread?.title ?? "Thread", () => {
          void navigate({ to: "/$threadId", params: { threadId } });
        });
      }
      if (event.type === "thread.session-set") {
        const { threadId, session } = event.payload;
        const previousStatus = sessionStatusByThread.get(threadId) ?? null;
        sessionStatusByThread.set(threadId, session.status);
        const threads = useStore.getState().threads;
        const thread = threads.find((t) => t.id === threadId);
        dispatchSessionSetNotification(
          threadId,
          thread?.title ?? "Thread",
          session.status,
          previousStatus,
          () => {
            void navigate({ to: "/$threadId", params: { threadId } });
          },
        );

        // For background threads the full snapshot sync is deferred, so the
        // sidebar would keep showing stale "Working" status indefinitely.
        // Eagerly patch session status in the store so the UI reflects the
        // real state without waiting for a full sync.
        if (!isCurrentThread && thread?.session) {
          useStore.setState((state) => ({
            threads: state.threads.map((t) => {
              if (t.id !== threadId || !t.session) return t;
              return {
                ...t,
                session: {
                  ...t.session,
                  orchestrationStatus: session.status,
                  status: toLegacySessionStatusFromOrchestration(session.status),
                  activeTurnId: session.activeTurnId ?? undefined,
                  updatedAt: session.updatedAt,
                  ...(session.lastError ? { lastError: session.lastError } : {}),
                },
              };
            }),
          }));
        }
      }

      // Only trigger expensive full snapshot sync for the currently viewed thread
      // or for project-level events that affect the sidebar/navigation.
      if (isCurrentThread || isProjectEvent) {
        domainEventFlushThrottler.maybeExecute();
      } else if (event.aggregateKind === "thread") {
        // For background threads, defer the sync until the user navigates there.
        deferredThreadIdsRef.current.add(event.aggregateId);
      }
    });
    const unsubTerminalEvent = api.terminal.onEvent((event) => {
      const hasRunningSubprocess = terminalRunningSubprocessFromEvent(event);
      if (hasRunningSubprocess === null) {
        return;
      }
      useTerminalStateStore
        .getState()
        .setTerminalActivity(
          ThreadId.makeUnsafe(event.threadId),
          event.terminalId,
          hasRunningSubprocess,
        );
    });
    const unsubWelcome = onServerWelcome((payload) => {
      void (async () => {
        await syncSnapshot();
        if (disposed) {
          return;
        }

        if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
          return;
        }
        setProjectExpanded(payload.bootstrapProjectId, true);

        if (pathnameRef.current !== "/") {
          return;
        }
        if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
          return;
        }
        await navigate({
          to: "/$threadId",
          params: { threadId: payload.bootstrapThreadId },
          replace: true,
        });
        handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
      })().catch(() => undefined);
    });
    const unsubServerConfigUpdated = onServerConfigUpdated((payload) => {
      const signature = JSON.stringify(payload.issues);
      if (lastConfigIssuesSignatureRef.current === signature) {
        return;
      }
      lastConfigIssuesSignatureRef.current = signature;

      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
      const issue = payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
      if (!issue) {
        toastManager.add({
          type: "success",
          title: "Keybindings updated",
          description: "Keybindings configuration reloaded successfully.",
        });
        return;
      }

      toastManager.add({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: issue.message,
        actionProps: {
          children: "Open keybindings.json",
          onClick: () => {
            void queryClient
              .ensureQueryData(serverConfigQueryOptions())
              .then((config) =>
                api.shell.openInEditor(config.keybindingsConfigPath, preferredTerminalEditor()),
              )
              .catch((error) => {
                toastManager.add({
                  type: "error",
                  title: "Unable to open keybindings file",
                  description:
                    error instanceof Error ? error.message : "Unknown error opening file.",
                });
              });
          },
        },
      });
    });
    return () => {
      disposed = true;
      needsProviderInvalidation = false;
      domainEventFlushThrottler.cancel();
      unsubDomainEvent();
      unsubTerminalEvent();
      unsubWelcome();
      unsubServerConfigUpdated();
    };
  }, [
    navigate,
    queryClient,
    removeOrphanedTerminalStates,
    setProjectExpanded,
    syncServerReadModel,
  ]);

  useEffect(() => {
    // When the user switches threads, flush any deferred sync.
    const match = pathname.match(/^\/([^/]+)/);
    const threadId = match ? match[1] : null;
    if (threadId && deferredThreadIdsRef.current.has(threadId)) {
      deferredThreadIdsRef.current.delete(threadId);
      const api = readNativeApi();
      if (api) {
        void api.orchestration.getSnapshot().then((snapshot) => {
          syncServerReadModel(snapshot);
        });
      }
    }
  }, [pathname, syncServerReadModel]);

  return null;
}

function DesktopProjectBootstrap() {
  // Desktop hydration runs through EventRouter project + orchestration sync.
  return null;
}
