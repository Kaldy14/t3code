import type { OrchestrationSessionMetrics, RateLimitEntry, ThreadId } from "@t3tools/contracts";
import { memo, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";
import {
  formatCost,
  formatContextPercent,
  formatDuration,
  formatTimeRemaining,
  formatTokenCount,
} from "../session-logic";
import { cn } from "~/lib/utils";

// ── Query helpers ─────────────────────────────────────────────────────

export const sessionMetricsQueryKeys = {
  all: ["orchestration", "sessionMetrics"] as const,
  thread: (threadId: ThreadId) => ["orchestration", "sessionMetrics", threadId] as const,
};

export function sessionMetricsQueryOptions(threadId: ThreadId | null) {
  return queryOptions({
    queryKey: threadId ? sessionMetricsQueryKeys.thread(threadId) : sessionMetricsQueryKeys.all,
    queryFn: async (): Promise<OrchestrationSessionMetrics> => {
      const api = ensureNativeApi();
      if (!threadId) throw new Error("No threadId");
      return api.orchestration.getSessionMetrics({ threadId });
    },
    enabled: threadId !== null,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
  });
}

// ── Circular progress ring ───────────────────────────────────────────

interface CircularProgressProps {
  percent: number;
  size?: number;
  strokeWidth?: number;
  className?: string;
}

const CircularProgress = memo(function CircularProgress({
  percent,
  size = 16,
  strokeWidth = 2,
  className,
}: CircularProgressProps) {
  const clamped = Math.min(100, Math.max(0, percent));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;

  const strokeColor =
    clamped >= 90 ? "stroke-red-500" : clamped >= 70 ? "stroke-yellow-500" : "stroke-green-500";

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn("shrink-0 -rotate-90", className)}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        className="stroke-muted/40"
        strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        className={cn("transition-[stroke-dashoffset] duration-500", strokeColor)}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
      />
    </svg>
  );
});

// ── Rate limit badge ─────────────────────────────────────────────────

const RATE_LIMIT_LABELS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "wk",
  seven_day_opus: "wk-opus",
  seven_day_sonnet: "wk-sonnet",
  overage: "overage",
};

const RateLimitBadge = memo(function RateLimitBadge({ entry }: { entry: RateLimitEntry }) {
  const label = RATE_LIMIT_LABELS[entry.rateLimitType] ?? entry.rateLimitType;
  const pct = Math.round(entry.utilization * 100);
  const remaining = entry.resetsAt ? formatTimeRemaining(entry.resetsAt) : null;
  const colorClass =
    pct >= 90 || entry.status === "rejected"
      ? "text-red-400"
      : pct >= 70 || entry.status === "allowed_warning"
        ? "text-yellow-400"
        : "";

  const title = [
    `${label}: ${pct}% used`,
    remaining ? `resets in ${remaining}` : null,
    entry.status !== "allowed" ? `status: ${entry.status}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1 tabular-nums", colorClass)}
      title={title}
    >
      <CircularProgress percent={pct} size={14} strokeWidth={2} />
      {label}:{pct}%{remaining ? `(${remaining})` : ""}
    </span>
  );
});

// ── Elapsed timer ─────────────────────────────────────────────────────

function useElapsed(startIso: string | null, isActive: boolean): string | null {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!isActive || !startIso) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActive, startIso]);

  if (!startIso) return null;
  const startMs = Date.parse(startIso);
  if (Number.isNaN(startMs)) return null;
  const elapsed = Math.max(0, nowMs - startMs);
  return formatDuration(elapsed);
}

// ── Main component ────────────────────────────────────────────────────

interface SessionHudProps {
  threadId: ThreadId;
  model: string | null;
  sessionStartedAt: string | null;
  isActive: boolean;
  latestTurnCompletedAt: string | null;
}

export const SessionHud = memo(function SessionHud({
  threadId,
  model,
  sessionStartedAt,
  isActive,
  latestTurnCompletedAt,
}: SessionHudProps) {
  const queryClient = useQueryClient();

  // Re-fetch metrics after each turn completes
  useEffect(() => {
    if (!latestTurnCompletedAt) return;
    void queryClient.invalidateQueries({
      queryKey: sessionMetricsQueryKeys.thread(threadId),
    });
  }, [latestTurnCompletedAt, threadId, queryClient]);

  const { data: metrics } = useQuery(sessionMetricsQueryOptions(threadId));
  const elapsed = useElapsed(sessionStartedAt, isActive);

  const hasMetrics = metrics !== undefined;
  const hasTokens = hasMetrics && (metrics.totalInputTokens > 0 || metrics.totalOutputTokens > 0);
  const hasCost = hasMetrics && metrics.totalCostUsd > 0;
  const hasContext =
    hasMetrics &&
    metrics.contextUsagePercent !== null &&
    metrics.contextWindowSize !== null &&
    metrics.contextWindowSize > 0;
  const hasRateLimits = hasMetrics && metrics.rateLimits.length > 0;

  // Don't render if there's nothing meaningful to show
  const hasAnything = hasTokens || hasCost || hasContext || hasRateLimits;
  if (!hasAnything) return null;

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 overflow-hidden border-b border-border/30 bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground sm:px-5"
      aria-label="Session metrics"
    >
      {/* Tokens */}
      {hasTokens && (
        <span className="shrink-0 tabular-nums" title="Input / Output tokens">
          <span>↓{formatTokenCount(metrics.totalInputTokens)}</span>
          <span className="mx-0.5 opacity-40">/</span>
          <span>↑{formatTokenCount(metrics.totalOutputTokens)}</span>
        </span>
      )}

      {/* Cost */}
      {hasCost && (
        <span className="shrink-0 tabular-nums" title="Total cost">
          {formatCost(metrics.totalCostUsd)}
        </span>
      )}

      {/* Context */}
      {hasContext && metrics.contextUsagePercent !== null && (
        <span
          className="inline-flex shrink-0 items-center gap-1 tabular-nums"
          title={`Context: ${metrics.contextUsedTokens != null ? formatTokenCount(metrics.contextUsedTokens) : "?"} / ${metrics.contextWindowSize != null ? formatTokenCount(metrics.contextWindowSize) : "?"} tokens (${formatContextPercent(metrics.contextUsagePercent)} used)`}
        >
          <CircularProgress percent={metrics.contextUsagePercent} />
          ctx:{metrics.contextUsedTokens != null ? formatTokenCount(metrics.contextUsedTokens) : ""}
          {metrics.contextWindowSize != null
            ? `/${formatTokenCount(metrics.contextWindowSize)}`
            : ""}
        </span>
      )}

      {/* Rate limits */}
      {hasRateLimits &&
        metrics.rateLimits.map((entry) => (
          <RateLimitBadge key={entry.rateLimitType} entry={entry} />
        ))}
    </div>
  );
});
