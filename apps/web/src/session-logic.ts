import {
  ApprovalRequestId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  type ProviderKind,
  type UserInputQuestion,
  type TurnId,
} from "@t3tools/contracts";

import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  ThreadSession,
  TurnDiffSummary,
} from "./types";

export type ProviderPickerKind = ProviderKind | "claudeCode" | "cursor";

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
}> = [
  { value: "claudeCode", label: "Claude Code", available: true },
  { value: "codex", label: "Codex", available: true },
  { value: "cursor", label: "Cursor", available: false },
];

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  label: string;
  detail?: string;
  command?: string;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
}

export interface SubagentGroup {
  taskId: string;
  parentToolUseId?: string;
  description: string;
  taskType?: string;
  status: "running" | "completed" | "failed" | "stopped";
  startedAt: string;
  completedAt?: string;
  summary?: string;
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
  childActivities: WorkLogEntry[];
}

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: "command" | "file-read" | "file-change";
  createdAt: string;
  detail?: string;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    }
  | {
      id: string;
      kind: "subagent";
      createdAt: string;
      subagent: SubagentGroup;
    };

export function formatTimestamp(isoDate: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(isoDate));
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

type LatestTurnTiming = Pick<OrchestrationLatestTurn, "turnId" | "startedAt" | "completedAt">;
type SessionActivityState = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  if (session.orchestrationStatus === "running") return false;
  return true;
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

function requestKindFromRequestType(requestType: unknown): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    const requestKind =
      payload &&
      (payload.requestKind === "command" ||
        payload.requestKind === "file-read" ||
        payload.requestKind === "file-change")
        ? payload.requestKind
        : payload
          ? requestKindFromRequestType(payload.requestType)
          : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      detail?.includes("Unknown pending permission request")
    ) {
      openByRequestId.delete(requestId);
      continue;
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;

    if (activity.kind === "user-input.requested" && requestId) {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActivePlanState | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const candidates = ordered.filter((activity) => {
    if (activity.kind !== "turn.plan.updated") {
      return false;
    }
    if (!latestTurnId) {
      return true;
    }
    return activity.turnId === latestTurnId;
  });
  const latest = candidates.at(-1);
  if (!latest) {
    return null;
  }
  const payload =
    latest.payload && typeof latest.payload === "object"
      ? (latest.payload as Record<string, unknown>)
      : null;
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps = rawPlan
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.step !== "string") {
        return null;
      }
      const status =
        record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
      return {
        step: record.step,
        status,
      };
    })
    .filter(
      (
        step,
      ): step is {
        step: string;
        status: "pending" | "inProgress" | "completed";
      } => step !== null,
    );
  if (steps.length === 0) {
    return null;
  }
  return {
    createdAt: latest.createdAt,
    turnId: latest.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    steps,
  };
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return {
        id: matchingTurnPlan.id,
        createdAt: matchingTurnPlan.createdAt,
        updatedAt: matchingTurnPlan.updatedAt,
        turnId: matchingTurnPlan.turnId,
        planMarkdown: matchingTurnPlan.planMarkdown,
      };
    }
  }

  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return null;
  }

  return {
    id: latestPlan.id,
    createdAt: latestPlan.createdAt,
    updatedAt: latestPlan.updatedAt,
    turnId: latestPlan.turnId,
    planMarkdown: latestPlan.planMarkdown,
  };
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): WorkLogEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  return (
    ordered
      .filter((activity) => (latestTurnId ? activity.turnId === latestTurnId : true))
      .filter((activity) => activity.kind !== "tool.started")
      .filter((activity) => activity.kind !== "task.started" && activity.kind !== "task.completed")
      .filter((activity) => activity.summary !== "Checkpoint captured")
      // Exclude activities that belong to a subagent group (rendered separately)
      .filter((activity) => !activity.taskId)
      .map((activity) => {
        const payload =
          activity.payload && typeof activity.payload === "object"
            ? (activity.payload as Record<string, unknown>)
            : null;
        const command = extractToolCommand(payload);
        const changedFiles = extractChangedFiles(payload);
        const entry: WorkLogEntry = {
          id: activity.id,
          createdAt: activity.createdAt,
          label: activity.summary,
          tone: activity.tone === "approval" ? "info" : activity.tone,
        };
        if (payload && typeof payload.detail === "string" && payload.detail.length > 0) {
          entry.detail = payload.detail;
        }
        if (command) {
          entry.command = command;
        }
        if (changedFiles.length > 0) {
          entry.changedFiles = changedFiles.map(shortenAbsolutePath);
        }
        return entry;
      })
  );
}

export function deriveSubagentGroups(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): SubagentGroup[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const filtered = ordered.filter((a) => (latestTurnId ? a.turnId === latestTurnId : true));

  // Collect task lifecycle events grouped by taskId
  const taskMap = new Map<
    string,
    {
      started?: OrchestrationThreadActivity;
      completed?: OrchestrationThreadActivity;
      progress: OrchestrationThreadActivity[];
    }
  >();

  for (const activity of filtered) {
    if (!activity.taskId) continue;
    const taskId = activity.taskId;
    if (!taskMap.has(taskId)) {
      taskMap.set(taskId, { progress: [] });
    }
    const entry = taskMap.get(taskId)!;
    if (activity.kind === "task.started") {
      entry.started = activity;
    } else if (activity.kind === "task.completed") {
      entry.completed = activity;
    } else {
      entry.progress.push(activity);
    }
  }

  const groups: SubagentGroup[] = [];
  for (const [taskId, task] of taskMap) {
    const startPayload = task.started?.payload as Record<string, unknown> | undefined;
    const completedPayload = task.completed?.payload as Record<string, unknown> | undefined;
    const usage = completedPayload?.usage as
      | { total_tokens?: number; tool_uses?: number; duration_ms?: number }
      | undefined;

    const group: SubagentGroup = {
      taskId,
      parentToolUseId: task.started?.parentToolUseId,
      description:
        (startPayload?.detail as string) ?? (startPayload?.taskType as string) ?? "Subagent",
      taskType: startPayload?.taskType as string | undefined,
      status: task.completed
        ? ((completedPayload?.status as SubagentGroup["status"]) ?? "completed")
        : "running",
      startedAt: task.started?.createdAt ?? task.progress[0]?.createdAt ?? "",
      completedAt: task.completed?.createdAt,
      summary: completedPayload?.detail as string | undefined,
      // @ts-expect-error exactOptionalPropertyTypes
      usage: usage
        ? {
            totalTokens: usage.total_tokens,
            toolUses: usage.tool_uses,
            durationMs: usage.duration_ms,
          }
        : undefined,
      childActivities: task.progress
        .filter((a) => a.kind !== "task.progress")
        .map((a) => {
          const payload =
            a.payload && typeof a.payload === "object"
              ? (a.payload as Record<string, unknown>)
              : null;
          return {
            id: a.id,
            createdAt: a.createdAt,
            label: a.summary,
            detail: (payload?.detail as string) ?? undefined,
            tone: (a.tone === "approval" ? "info" : a.tone) as WorkLogEntry["tone"],
          };
        }),
    };
    groups.push(group);
  }

  return groups;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Shorten an absolute file path to a project-relative form for display.
 * Finds common root markers (/src/, /apps/, etc.) and strips the prefix.
 * Falls back to the last 3 path segments for unrecognized layouts.
 */
export function shortenAbsolutePath(filePath: string): string {
  const markers = [
    "/src/",
    "/lib/",
    "/packages/",
    "/apps/",
    "/test/",
    "/tests/",
    "/spec/",
    "/scripts/",
  ];
  for (const marker of markers) {
    const idx = filePath.indexOf(marker);
    if (idx !== -1) {
      return filePath.slice(idx + 1);
    }
  }
  const segments = filePath.split("/").filter(Boolean);
  if (segments.length > 3) {
    return `…/${segments.slice(-3).join("/")}`;
  }
  return filePath;
}

function normalizeCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

function extractToolCommand(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
  ];
  return candidates.find((candidate) => candidate !== null) ?? null;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.file_path);
  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const data = asRecord(payload?.data);
  const changedFiles: string[] = [];
  collectChangedFiles(data, changedFiles, new Set<string>(), 0);
  return changedFiles;
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

/**
 * Derives a human-readable status label describing what the agent is currently doing.
 * Returns null when there's no meaningful in-flight activity to display.
 */
export function deriveCurrentActivityStatus(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): string | null {
  if (!latestTurnId) return null;

  const ordered = [...activities]
    .filter((a) => a.turnId === latestTurnId)
    .toSorted(compareActivitiesByOrder);

  // Walk backwards to find the most recent meaningful activity
  for (let i = ordered.length - 1; i >= 0; i--) {
    const activity = ordered[i];
    if (!activity) continue;

    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;
    const itemType = payload && typeof payload.itemType === "string" ? payload.itemType : undefined;

    switch (activity.kind) {
      case "tool.started":
      case "tool.updated":
        return formatToolStatusLabel(itemType, activity.summary, detail);
      case "tool.completed":
        // Between tools — agent is thinking about next step
        return null;
      case "task.progress":
        return detail ?? "Reasoning…";
      case "task.started":
        return detail ?? "Starting task…";
      case "task.completed":
        return null;
      default:
        continue;
    }
  }

  return null;
}

/**
 * Derives the last N human-readable activity status labels for the current turn.
 * Used to show recent activity history inside the subagent card.
 */
export function deriveRecentActivityStatuses(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
  count = 3,
): string[] {
  if (!latestTurnId) return [];

  const ordered = [...activities]
    .filter((a) => a.turnId === latestTurnId)
    .toSorted(compareActivitiesByOrder);

  const result: string[] = [];
  const seen = new Set<string>();

  for (let i = ordered.length - 1; i >= 0 && result.length < count; i--) {
    const activity = ordered[i];
    if (!activity) continue;

    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;
    const itemType = payload && typeof payload.itemType === "string" ? payload.itemType : undefined;

    let label: string | null = null;
    switch (activity.kind) {
      case "tool.started":
      case "tool.updated":
        label = formatToolStatusLabel(itemType, activity.summary, detail);
        break;
      case "tool.completed":
        label = formatToolStatusLabel(itemType, activity.summary, detail);
        break;
      case "task.progress":
        label = detail ?? null;
        break;
      case "task.started":
        label = detail ?? null;
        break;
      default:
        continue;
    }

    if (label && !seen.has(label)) {
      seen.add(label);
      result.push(label);
    }
  }

  // Reverse so oldest is first, newest is last (for progressive opacity)
  return result.reverse();
}

const STATUS_LABEL_MAX_LENGTH = 80;

function formatToolStatusLabel(
  itemType: string | undefined,
  summary: string,
  detail: string | undefined,
): string {
  const verb = itemTypeToVerb(itemType);
  if (detail) {
    const truncated =
      detail.length > STATUS_LABEL_MAX_LENGTH
        ? `${detail.slice(0, STATUS_LABEL_MAX_LENGTH - 1)}…`
        : detail;
    return verb ? `${verb} ${truncated}` : truncated;
  }
  return verb ?? summary;
}

function itemTypeToVerb(itemType: string | undefined): string | null {
  switch (itemType) {
    case "command_execution":
      return "Running";
    case "file_change":
      return "Editing";
    case "mcp_tool_call":
      return "Using tool";
    case "dynamic_tool_call":
      return "Using tool";
    case "collab_agent_tool_call":
      return "Agent";
    case "web_search":
      return "Searching";
    case "image_view":
      return "Viewing image";
    default:
      return null;
  }
}

export function hasToolActivityForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  return activities.some((activity) => activity.turnId === turnId && activity.tone === "tool");
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  proposedPlans: ProposedPlan[],
  workEntries: WorkLogEntry[],
  subagentGroups: SubagentGroup[] = [],
): TimelineEntry[] {
  const messageRows: TimelineEntry[] = messages.map((message) => ({
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message,
  }));
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  const workRows: TimelineEntry[] = workEntries.map((entry) => ({
    id: entry.id,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));
  const subagentRows: TimelineEntry[] = subagentGroups.map((subagent) => ({
    id: `subagent:${subagent.taskId}`,
    kind: "subagent",
    createdAt: subagent.startedAt,
    subagent,
  }));
  return [...messageRows, ...proposedPlanRows, ...workRows, ...subagentRows].toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export function inferCheckpointTurnCountByTurnId(
  summaries: TurnDiffSummary[],
): Record<TurnId, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<TurnId, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${tokens}`;
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatContextPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}

/**
 * Format a future epoch timestamp (ms) as a compact remaining duration.
 * e.g. "3h42m", "2d5h", "45m", "< 1m"
 */
export function formatTimeRemaining(resetsAtMs: number): string {
  const remaining = Math.max(0, resetsAtMs - Date.now());
  if (remaining < 60_000) return "< 1m";
  const totalMinutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (days > 0) return `${days}d${remainingHours}h`;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}
