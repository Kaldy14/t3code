/**
 * ClaudeCodeAdapterLive - Scoped live implementation for the Claude Code provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeCodeAdapterLive
 */
import * as childProcess from "node:child_process";
import {
  type CanUseTool,
  type ElicitationResult,
  type OnElicitation,
  query,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  type McpServerStatus,
  type McpSetServersResult,
  type ProviderApprovalDecision,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Cause, DateTime, Deferred, Effect, Fiber, Layer, PubSub, Queue, Random, Ref, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { ClaudeCodeAdapter, type ClaudeCodeAdapterShape } from "../Services/ClaudeCodeAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "claudeCode" as const;
const CURSOR_DEBOUNCE_MS = 500;

type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

interface ClaudeResumeState {
  readonly threadId?: ThreadId;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
}

interface ClaudeTurnState {
  readonly turnId: TurnId;
  assistantItemId: string;
  readonly startedAt: string;
  readonly items: Array<unknown>;
  readonly messageCompleted: boolean;
  emittedTextDelta: boolean;
  fallbackAssistantText: string;
  lastBlockWasToolUse: boolean;
  /** When true, the turn was started in plan mode and should emit a proposed plan on completion. */
  readonly isPlanMode: boolean;
  /**
   * Context window occupancy from the latest parent-level API call.
   * Derived from `BetaMessage.usage` on `SDKAssistantMessage` where
   * `parent_tool_use_id === null`. Equals `input_tokens +
   * cache_creation_input_tokens + cache_read_input_tokens` for that
   * single API call — the actual context window fill level.
   */
  latestContextOccupancy?: number;
}

interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingElicitation {
  readonly requestId: ApprovalRequestId;
  readonly serverName: string;
  readonly message: string;
  readonly mode: "form" | "url" | undefined;
  readonly requestedSchema: Record<string, unknown> | undefined;
  readonly decision: Deferred.Deferred<ElicitationResult>;
}

interface PendingUserQuestion {
  readonly requestId: ApprovalRequestId;
  readonly toolInput: Record<string, unknown>;
  readonly decision: Deferred.Deferred<Record<string, string>>;
}

interface ToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  detail?: string;
  /** Accumulated input_json_delta chunks for re-summarization at block stop. */
  inputJsonChunks: string[];
  /** Initial tool input captured at content_block_start (may be partial). */
  readonly initialInput: Record<string, unknown>;
}

interface ClaudeSessionContext {
  /** Internal thread ID used as the sessions Map key (always `input.threadId`). */
  readonly internalThreadId: ThreadId;
  session: ProviderSession;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
  readonly startedAt: string;
  /** The permission mode the session was started with, used to restore after plan mode. */
  readonly basePermissionMode: PermissionMode;
  resumeSessionId: string | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingElicitations: Map<ApprovalRequestId, PendingElicitation>;
  readonly pendingUserQuestions: Map<ApprovalRequestId, PendingUserQuestion>;
  readonly turns: Array<{
    id: TurnId;
    items: Array<unknown>;
  }>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  turnState: ClaudeTurnState | undefined;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  stopped: boolean;
  /** Set after `interruptTurn` so late SDK status messages don't flip status back to "running". Reset on next turn start. */
  interrupted: boolean;
  lastPersistedCursorAt: number;
  pendingCursorWrite: unknown | undefined;
  availableSlashCommands: string[];
  /** Handle to the SDK stream processing fiber so it can be interrupted on stop. */
  streamFiber: Fiber.Fiber<void> | undefined;
}

interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly close: () => void;
  // MCP operations
  readonly mcpServerStatus: () => Promise<unknown[]>;
  readonly setMcpServers: (servers: Record<string, unknown>) => Promise<unknown>;
  readonly reconnectMcpServer: (serverName: string) => Promise<void>;
  readonly toggleMcpServer: (serverName: string, enabled: boolean) => Promise<void>;
}

export interface ClaudeCodeAdapterLiveOptions {
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly persistResumeCursor?: (
    threadId: ThreadId,
    cursor: unknown,
  ) => Effect.Effect<void>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSyntheticClaudeThreadId(value: string): boolean {
  return value.startsWith("claude-thread-");
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(value);
}

function asCanonicalTurnId(value: TurnId): TurnId {
  return value;
}

function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(value);
}

function toPermissionMode(value: unknown): PermissionMode | undefined {
  switch (value) {
    case "default":
    case "acceptEdits":
    case "bypassPermissions":
    case "plan":
    case "dontAsk":
      return value;
    default:
      return undefined;
  }
}

function readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as {
    threadId?: unknown;
    resume?: unknown;
    sessionId?: unknown;
    resumeSessionAt?: unknown;
    turnCount?: unknown;
  };

  const threadIdCandidate = typeof cursor.threadId === "string" ? cursor.threadId : undefined;
  const threadId =
    threadIdCandidate && !isSyntheticClaudeThreadId(threadIdCandidate)
      ? ThreadId.makeUnsafe(threadIdCandidate)
      : undefined;
  const resumeCandidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;
  const resume = resumeCandidate && isUuid(resumeCandidate) ? resumeCandidate : undefined;
  const resumeSessionAt =
    typeof cursor.resumeSessionAt === "string" ? cursor.resumeSessionAt : undefined;
  const turnCountValue = typeof cursor.turnCount === "number" ? cursor.turnCount : undefined;

  return {
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnCountValue !== undefined && Number.isInteger(turnCountValue) && turnCountValue >= 0
      ? { turnCount: turnCountValue }
      : {}),
  };
}

function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  return "dynamic_tool_call";
}

function classifyRequestType(toolName: string): CanonicalRequestType {
  const normalized = toolName.toLowerCase();
  if (normalized === "read" || normalized.includes("read file") || normalized.includes("view")) {
    return "file_read_approval";
  }
  return classifyToolItemType(toolName) === "command_execution"
    ? "command_execution_approval"
    : "file_change_approval";
}

/**
 * Shorten an absolute file path to a project-relative form for display.
 * Looks for common root markers (/src/, /apps/, etc.) and strips the prefix.
 * Falls back to the last 3 path segments.
 */
function shortenAbsolutePath(filePath: string): string {
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

function extractFirstFilePath(input: Record<string, unknown>): string | undefined {
  for (const key of ["file_path", "filePath", "path", "filename"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Extract only small metadata fields from tool input (file paths, patterns, commands).
 * Omits large string values (file content, old_string, new_string) to keep payloads small.
 */
function extractToolInputMeta(input: Record<string, unknown>): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const key of [
    "file_path",
    "filePath",
    "path",
    "pattern",
    "command",
    "cmd",
    "query",
    "url",
    "description",
    "glob",
    "type",
    "output_mode",
  ]) {
    if (typeof input[key] === "string") {
      meta[key] = (input[key] as string).slice(0, 500);
    }
  }
  return meta;
}

function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  // Commands: show the command text directly
  const commandValue = input.command ?? input.cmd;
  if (typeof commandValue === "string" && commandValue.trim().length > 0) {
    return commandValue.trim().slice(0, 400);
  }

  // File path based tools: show a clean shortened path
  const filePath = extractFirstFilePath(input);
  if (filePath) {
    const shortPath = shortenAbsolutePath(filePath);
    // For search-like tools with a pattern, include it
    const pattern = typeof input.pattern === "string" ? input.pattern : undefined;
    if (pattern) {
      return `"${pattern.slice(0, 80)}" in ${shortPath}`;
    }
    return shortPath;
  }

  // Pattern/query-based tools (Grep without a file path, Glob, WebSearch)
  const pattern = input.pattern ?? input.query ?? input.search;
  if (typeof pattern === "string") {
    return `"${pattern.slice(0, 120)}"`;
  }

  // Agent/task tools: show the description
  const description = input.description ?? input.prompt;
  if (typeof description === "string") {
    return description.slice(0, 200);
  }

  // URL-based tools
  if (typeof input.url === "string") {
    return input.url.slice(0, 200);
  }

  // Fallback: JSON summary (shorter limit than before)
  const serialized = JSON.stringify(input);
  if (serialized.length <= 200) {
    return serialized;
  }
  return `${serialized.slice(0, 197)}...`;
}

function titleForTool(itemType: CanonicalItemType, toolName: string): string {
  const lower = toolName.toLowerCase();
  // Known Claude Code tools — use specific, human-readable names
  if (lower === "edit" || lower === "multiedit") return "Edit";
  if (lower === "write") return "Write";
  if (lower === "read") return "Read";
  if (lower === "grep") return "Search";
  if (lower === "glob") return "Find files";
  if (lower === "bash") return "Run command";
  if (lower === "agent") return "Agent task";
  if (lower === "websearch" || lower === "web_search") return "Web search";
  if (lower === "webfetch" || lower === "web_fetch") return "Web fetch";
  if (lower === "todowrite" || lower === "todo_write") return "Todo update";
  if (lower === "notebookedit" || lower === "notebook_edit") return "Notebook edit";
  if (lower === "skill") return "Skill";
  if (lower === "toolsearch") return "Tool search";

  // Fallback to category-based labels
  switch (itemType) {
    case "command_execution":
      return "Run command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return toolName;
    case "dynamic_tool_call":
      return toolName;
    default:
      return "Tool";
  }
}

function buildUserMessage(input: ProviderSendTurnInput): SDKUserMessage {
  const fragments: string[] = [];

  if (input.conversationContext && input.conversationContext.trim().length > 0) {
    fragments.push(input.conversationContext.trim());
  }

  if (input.input && input.input.trim().length > 0) {
    fragments.push(input.input.trim());
  }

  for (const attachment of input.attachments ?? []) {
    if (attachment.type === "image") {
      fragments.push(
        `Attached image: ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes).`,
      );
    }
  }

  const text = fragments.join("\n\n");

  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  } as SDKUserMessage;
}

function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus {
  if (result.subtype === "success") {
    return "completed";
  }

  const errors = result.errors.join(" ").toLowerCase();
  if (errors.includes("interrupt")) {
    return "interrupted";
  }
  if (errors.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

function streamKindFromDeltaType(deltaType: string): "assistant_text" | "reasoning_text" {
  return deltaType.includes("thinking") ? "reasoning_text" : "assistant_text";
}

function providerThreadRef(
  context: ClaudeSessionContext,
): { readonly providerThreadId: string } | {} {
  return context.resumeSessionId ? { providerThreadId: context.resumeSessionId } : {};
}

function extractAssistantText(message: SDKMessage): string {
  if (message.type !== "assistant") {
    return "";
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return "";
  }

  const fragments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (
      candidate.type === "text" &&
      typeof candidate.text === "string" &&
      candidate.text.length > 0
    ) {
      fragments.push(candidate.text);
    }
  }

  return fragments.join("");
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function sdkMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { type?: unknown };
  return typeof record.type === "string" ? record.type : undefined;
}

function sdkMessageSubtype(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { subtype?: unknown };
  return typeof record.subtype === "string" ? record.subtype : undefined;
}

function sdkNativeMethod(message: SDKMessage): string {
  const subtype = sdkMessageSubtype(message);
  if (subtype) {
    return `claude/${message.type}/${subtype}`;
  }

  if (message.type === "stream_event") {
    const streamType = sdkMessageType(message.event);
    if (streamType) {
      const deltaType =
        streamType === "content_block_delta"
          ? sdkMessageType((message.event as { delta?: unknown }).delta)
          : undefined;
      if (deltaType) {
        return `claude/${message.type}/${streamType}/${deltaType}`;
      }
      return `claude/${message.type}/${streamType}`;
    }
  }

  return `claude/${message.type}`;
}

function sdkNativeItemId(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    const maybeId = (message.message as { id?: unknown }).id;
    if (typeof maybeId === "string") {
      return maybeId;
    }
    return undefined;
  }

  if (message.type === "stream_event") {
    const event = message.event as {
      type?: unknown;
      content_block?: { id?: unknown };
    };
    if (event.type === "content_block_start" && typeof event.content_block?.id === "string") {
      return event.content_block.id;
    }
  }

  return undefined;
}

/**
 * Env vars that must not leak to spawned Claude Code processes.
 * `ELECTRON_RUN_AS_NODE` causes Electron-based CLI binaries (e.g. claude
 * installed via cmux) to run as plain Node instead of their normal entry,
 * which makes them crash immediately with exit code 1.
 */
const STRIPPED_ENV_KEYS = [
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  // cmux wrapper injects --session-id and --settings flags when this is set,
  // which conflicts with the SDK's own arguments.
  "CMUX_SURFACE_ID",
  "CMUX_CLAUDE_HOOKS_DISABLED",
];

function sanitizedProcessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of STRIPPED_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

/**
 * Resolve the absolute path to the `claude` CLI binary.
 *
 * In desktop (Electron) builds the SDK's bundled `cli.js` lives inside the
 * asar archive and cannot be spawned by a regular `node` child process.
 * By resolving the system-installed `claude` binary and passing it as
 * `pathToClaudeCodeExecutable`, the SDK spawns it directly as a native
 * executable — bypassing the asar limitation entirely.
 */
let cachedClaudeBinaryPath: string | undefined | null = null;

function resolveClaudeBinaryPath(): string | undefined {
  if (cachedClaudeBinaryPath !== null) return cachedClaudeBinaryPath;
  try {
    // `which -a` lists all matches in PATH order. We skip shell-script
    // wrappers (e.g. cmux) that inject flags incompatible with the SDK.
    const result = childProcess.execFileSync("which", ["-a", "claude"], {
      encoding: "utf8",
      timeout: 3_000,
    });
    const candidates = result
      .trim()
      .split("\n")
      .filter((p) => p.length > 0);
    for (const candidate of candidates) {
      try {
        const head = childProcess.execFileSync("head", ["-c", "64", candidate], {
          encoding: "utf8",
          timeout: 1_000,
        });
        // Skip shell script wrappers — they inject flags that conflict with the SDK.
        if (head.startsWith("#!")) continue;
        cachedClaudeBinaryPath = candidate;
        return cachedClaudeBinaryPath;
      } catch {
        continue;
      }
    }
    // Fallback to first candidate if all are scripts (better than nothing).
    cachedClaudeBinaryPath = candidates[0];
  } catch {
    cachedClaudeBinaryPath = undefined;
  }
  return cachedClaudeBinaryPath;
}

function makeClaudeCodeAdapter(options?: ClaudeCodeAdapterLiveOptions) {
  return Effect.gen(function* () {
    const persistResumeCursorCallback = options?.persistResumeCursor;

    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    const createQuery =
      options?.createQuery ??
      ((input: {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }) => query({ prompt: input.prompt, options: input.options }) as ClaudeQueryRuntime);

    const sessions = new Map<ThreadId, ClaudeSessionContext>();
    /** Provider-level cache of slash commands from the most recent session init. */
    let cachedSlashCommands: string[] = [];
    const runtimeEventQueue = yield* Queue.sliding<ProviderRuntimeEvent>(10_000);
    const approvalEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

    const offerApprovalEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      PubSub.publish(approvalEventPubSub, event).pipe(Effect.asVoid);

    const logNativeSdkMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!nativeEventLogger) {
          return;
        }

        const observedAt = new Date().toISOString();
        const itemId = sdkNativeItemId(message);

        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id:
                "uuid" in message && typeof message.uuid === "string"
                  ? message.uuid
                  : crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method: sdkNativeMethod(message),
              threadId: context.internalThreadId,
              ...(typeof message.session_id === "string"
                ? { providerThreadId: message.session_id }
                : {}),
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              ...(itemId ? { itemId: ProviderItemId.makeUnsafe(itemId) } : {}),
              payload: message,
            },
          },
          null,
        );
      });

    const snapshotThread = (
      context: ClaudeSessionContext,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{
          id: TurnId;
          items: ReadonlyArray<unknown>;
        }>;
      },
      ProviderAdapterValidationError
    > =>
      Effect.gen(function* () {
        const threadId = context.session.threadId;
        if (!threadId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "readThread",
            issue: "Session thread id is not initialized yet.",
          });
        }
        return {
          threadId,
          turns: context.turns.map((turn) => ({
            id: turn.id,
            items: [...turn.items],
          })),
        };
      });

    const updateResumeCursor = (context: ClaudeSessionContext): Effect.Effect<void> =>
      Effect.gen(function* () {
        const threadId = context.session.threadId;
        if (!threadId) return;

        const resumeCursor = {
          threadId,
          ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
          ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
          turnCount: context.turns.length,
        };

        context.session = {
          ...context.session,
          resumeCursor,
          updatedAt: yield* nowIso,
        };

        // Eagerly persist with per-session debouncing
        if (persistResumeCursorCallback) {
          const now = Date.now();
          context.pendingCursorWrite = resumeCursor;
          if (now - context.lastPersistedCursorAt > CURSOR_DEBOUNCE_MS) {
            context.lastPersistedCursorAt = now;
            context.pendingCursorWrite = undefined;
            yield* persistResumeCursorCallback(threadId, resumeCursor).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to persist resume cursor", {
                  threadId,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
          }
        }
      });

    const flushPendingCursor = (context: ClaudeSessionContext): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (persistResumeCursorCallback && context.pendingCursorWrite && context.session.threadId) {
          const cursor = context.pendingCursorWrite;
          context.pendingCursorWrite = undefined;
          context.lastPersistedCursorAt = Date.now();
          yield* persistResumeCursorCallback(context.session.threadId, cursor);
        }
      });

    const ensureThreadId = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (typeof message.session_id !== "string" || message.session_id.length === 0) {
          return;
        }
        const nextThreadId = message.session_id;
        context.resumeSessionId = message.session_id;
        if (!context.session.threadId) {
          context.session = {
            ...context.session,
            threadId: ThreadId.makeUnsafe(nextThreadId),
          };
        }
        yield* updateResumeCursor(context);

        if (context.lastThreadStartedId !== nextThreadId) {
          context.lastThreadStartedId = nextThreadId;
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "thread.started",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.internalThreadId,
            payload: {
              providerThreadId: nextThreadId,
            },
            providerRefs: {},
            raw: {
              source: "claude.sdk.message",
              method: "claude/thread/started",
              payload: {
                session_id: message.session_id,
              },
            },
          });
        }
      });

    const emitRuntimeError = (
      context: ClaudeSessionContext,
      message: string,
      cause?: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "runtime.error",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.internalThreadId,
          ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
          payload: {
            message,
            class: "provider_error",
            ...(cause !== undefined ? { detail: cause } : {}),
          },
          providerRefs: {
            ...providerThreadRef(context),
            ...(turnState ? { providerTurnId: String(turnState.turnId) } : {}),
          },
        });
      });

    const emitRuntimeWarning = (
      context: ClaudeSessionContext,
      message: string,
      detail?: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "runtime.warning",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.internalThreadId,
          ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
          payload: {
            message,
            ...(detail !== undefined ? { detail } : {}),
          },
          providerRefs: {
            ...providerThreadRef(context),
            ...(turnState ? { providerTurnId: String(turnState.turnId) } : {}),
          },
        });
      });

    const completeTurn = (
      context: ClaudeSessionContext,
      status: ProviderRuntimeTurnStatus,
      errorMessage?: string,
      result?: SDKResultMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* flushPendingCursor(context);
        const turnState = context.turnState;
        if (!turnState) {
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "turn.completed",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.internalThreadId,
            payload: {
              state: status,
              ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
              ...(result?.usage ? { usage: result.usage } : {}),
              ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
              ...(typeof result?.total_cost_usd === "number"
                ? { totalCostUsd: result.total_cost_usd }
                : {}),
              ...(errorMessage ? { errorMessage } : {}),
            },
            providerRefs: {},
          });
          return;
        }

        if (!turnState.messageCompleted) {
          if (!turnState.emittedTextDelta && turnState.fallbackAssistantText.length > 0) {
            const deltaStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "content.delta",
              eventId: deltaStamp.eventId,
              provider: PROVIDER,
              createdAt: deltaStamp.createdAt,
              threadId: context.internalThreadId,
              turnId: turnState.turnId,
              itemId: asRuntimeItemId(turnState.assistantItemId),
              payload: {
                streamKind: "assistant_text",
                delta: turnState.fallbackAssistantText,
              },
              providerRefs: {
                ...providerThreadRef(context),
                providerTurnId: String(turnState.turnId),
                providerItemId: ProviderItemId.makeUnsafe(turnState.assistantItemId),
              },
            });
          }

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.completed",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            itemId: asRuntimeItemId(turnState.assistantItemId),
            threadId: context.internalThreadId,
            turnId: turnState.turnId,
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
            },
            providerRefs: {
              ...providerThreadRef(context),
              providerTurnId: turnState.turnId,
              providerItemId: ProviderItemId.makeUnsafe(turnState.assistantItemId),
            },
          });
        }

        context.turns.push({
          id: turnState.turnId,
          items: [...turnState.items],
        });
        // Cap in-memory turn history to prevent unbounded growth in long sessions.
        // Only metadata (id) is needed for rollback; older turns are discarded.
        const MAX_RETAINED_TURNS = 200;
        if (context.turns.length > MAX_RETAINED_TURNS) {
          context.turns.splice(0, context.turns.length - MAX_RETAINED_TURNS);
        }

        // When the turn was started in plan mode and completed successfully,
        // emit a proposed-plan event so the ingestion pipeline creates a
        // first-class proposed plan that the UI can present for review.
        if (
          turnState.isPlanMode &&
          status === "completed" &&
          turnState.fallbackAssistantText.length > 0
        ) {
          const planStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "turn.proposed.completed",
            eventId: planStamp.eventId,
            provider: PROVIDER,
            createdAt: planStamp.createdAt,
            threadId: context.internalThreadId,
            turnId: turnState.turnId,
            payload: {
              planMarkdown: turnState.fallbackAssistantText,
            },
            providerRefs: {
              ...providerThreadRef(context),
              providerTurnId: turnState.turnId,
            },
          });
        }

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.internalThreadId,
          turnId: turnState.turnId,
          payload: {
            state: status,
            ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
            ...(result?.usage ? { usage: result.usage } : {}),
            ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
            ...(typeof result?.total_cost_usd === "number"
              ? { totalCostUsd: result.total_cost_usd }
              : {}),
            ...(turnState.latestContextOccupancy !== undefined
              ? { contextOccupancyTokens: turnState.latestContextOccupancy }
              : {}),
            ...(errorMessage ? { errorMessage } : {}),
          },
          providerRefs: {
            ...providerThreadRef(context),
            providerTurnId: turnState.turnId,
          },
        });

        const updatedAt = yield* nowIso;
        context.turnState = undefined;
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt,
          ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
        };
        yield* updateResumeCursor(context);
      });

    const handleStreamEvent = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "stream_event") {
          return;
        }

        const { event } = message;

        if (event.type === "content_block_delta") {
          // Accumulate input_json_delta chunks for tool input re-summarization
          if (
            event.delta.type === "input_json_delta" &&
            typeof event.delta.partial_json === "string"
          ) {
            const tool = context.inFlightTools.get(event.index);
            if (tool) {
              tool.inputJsonChunks.push(event.delta.partial_json);
            }
          }

          if (
            event.delta.type === "text_delta" &&
            event.delta.text.length > 0 &&
            context.turnState
          ) {
            if (!context.turnState.emittedTextDelta) {
              context.turnState = {
                ...context.turnState,
                emittedTextDelta: true,
              };
            }
            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "content.delta",
              eventId: stamp.eventId,
              provider: PROVIDER,
              createdAt: stamp.createdAt,
              threadId: context.internalThreadId,
              turnId: context.turnState.turnId,
              itemId: asRuntimeItemId(context.turnState.assistantItemId),
              payload: {
                streamKind: streamKindFromDeltaType(event.delta.type),
                delta: event.delta.text,
              },
              providerRefs: {
                ...providerThreadRef(context),
                providerTurnId: context.turnState.turnId,
                providerItemId: ProviderItemId.makeUnsafe(context.turnState.assistantItemId),
              },
              raw: {
                source: "claude.sdk.message",
                method: "claude/stream_event/content_block_delta",
                payload: message,
              },
            });
          }
          return;
        }

        if (event.type === "content_block_start") {
          const { index, content_block: block } = event;
          const isToolBlock =
            block.type === "tool_use" ||
            block.type === "server_tool_use" ||
            block.type === "mcp_tool_use";

          if (!isToolBlock) {
            // Text content block starting — if the previous block was a tool,
            // finalize the current assistant message and start a new one so
            // each text segment becomes a separate chat message.
            if (context.turnState?.lastBlockWasToolUse) {
              const ts = context.turnState;
              if (ts.emittedTextDelta || ts.fallbackAssistantText.length > 0) {
                // Finalize the previous assistant text segment
                const stamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  type: "item.completed",
                  eventId: stamp.eventId,
                  provider: PROVIDER,
                  createdAt: stamp.createdAt,
                  itemId: asRuntimeItemId(ts.assistantItemId),
                  threadId: context.internalThreadId,
                  turnId: ts.turnId,
                  payload: {
                    itemType: "assistant_message",
                    status: "completed",
                    title: "Assistant message",
                  },
                  providerRefs: {
                    ...providerThreadRef(context),
                    providerTurnId: ts.turnId,
                    providerItemId: ProviderItemId.makeUnsafe(ts.assistantItemId),
                  },
                });
              }

              // Generate a new assistant item ID for the next text segment
              ts.assistantItemId = crypto.randomUUID();
              ts.emittedTextDelta = false;
              ts.fallbackAssistantText = "";
              ts.lastBlockWasToolUse = false;
            }
            return;
          }

          const toolName = block.name;
          const itemType = classifyToolItemType(toolName);
          const toolInput =
            typeof block.input === "object" && block.input !== null
              ? (block.input as Record<string, unknown>)
              : {};
          const itemId = block.id;
          const detail = summarizeToolRequest(toolName, toolInput);

          const tool: ToolInFlight = {
            itemId,
            itemType,
            toolName,
            title: titleForTool(itemType, toolName),
            detail,
            inputJsonChunks: [],
            initialInput: toolInput,
          };
          context.inFlightTools.set(index, tool);

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.started",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.internalThreadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: "inProgress",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: {
                toolName: tool.toolName,
                input: toolInput,
              },
            },
            providerRefs: {
              ...providerThreadRef(context),
              ...(context.turnState ? { providerTurnId: String(context.turnState.turnId) } : {}),
              providerItemId: ProviderItemId.makeUnsafe(tool.itemId),
            },
            raw: {
              source: "claude.sdk.message",
              method: "claude/stream_event/content_block_start",
              payload: message,
            },
          });
          return;
        }

        if (event.type === "content_block_stop") {
          const { index } = event;
          const tool = context.inFlightTools.get(index);
          if (!tool) {
            return;
          }
          context.inFlightTools.delete(index);

          // Re-summarize with the full accumulated tool input if available,
          // falling back to the initial input captured at content_block_start.
          let finalInput: Record<string, unknown> = tool.initialInput;
          if (tool.inputJsonChunks.length > 0) {
            try {
              finalInput = JSON.parse(tool.inputJsonChunks.join("")) as Record<string, unknown>;
            } catch {
              // Keep the initial input if JSON parsing fails
            }
          }
          tool.detail = summarizeToolRequest(tool.toolName, finalInput);
          const inputMeta = extractToolInputMeta(finalInput);

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.completed",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.internalThreadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: "completed",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: {
                toolName: tool.toolName,
                input: inputMeta,
              },
            },
            providerRefs: {
              ...providerThreadRef(context),
              ...(context.turnState ? { providerTurnId: String(context.turnState.turnId) } : {}),
              providerItemId: ProviderItemId.makeUnsafe(tool.itemId),
            },
            raw: {
              source: "claude.sdk.message",
              method: "claude/stream_event/content_block_stop",
              payload: message,
            },
          });

          // Mark that the last completed block was a tool, so the next
          // text content_block_start knows to create a new assistant message.
          if (context.turnState) {
            context.turnState.lastBlockWasToolUse = true;
          }
        }
      });

    const handleAssistantMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "assistant") {
          return;
        }

        if (context.turnState) {
          context.turnState.items.push(message.message);
          const fallbackAssistantText = extractAssistantText(message);
          if (
            fallbackAssistantText.length > 0 &&
            fallbackAssistantText !== context.turnState.fallbackAssistantText
          ) {
            context.turnState = {
              ...context.turnState,
              fallbackAssistantText,
            };
          }

          // Track context window occupancy from parent-level API calls.
          // `parent_tool_use_id === null` means this is the main conversation,
          // not a subagent. BetaMessage.usage has per-API-call token counts.
          if (message.parent_tool_use_id === null) {
            const betaUsage = (message.message as { usage?: Record<string, unknown> })?.usage;
            if (betaUsage) {
              const inputTokens =
                typeof betaUsage.input_tokens === "number" ? betaUsage.input_tokens : 0;
              const cacheCreation =
                typeof betaUsage.cache_creation_input_tokens === "number"
                  ? betaUsage.cache_creation_input_tokens
                  : 0;
              const cacheRead =
                typeof betaUsage.cache_read_input_tokens === "number"
                  ? betaUsage.cache_read_input_tokens
                  : 0;
              context.turnState.latestContextOccupancy = inputTokens + cacheCreation + cacheRead;
            }
          }

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.updated",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.internalThreadId,
            turnId: context.turnState.turnId,
            itemId: asRuntimeItemId(context.turnState.assistantItemId),
            payload: {
              itemType: "assistant_message",
              status: "inProgress",
              title: "Assistant message",
              data: message.message,
            },
            providerRefs: {
              ...providerThreadRef(context),
              providerTurnId: context.turnState.turnId,
              providerItemId: ProviderItemId.makeUnsafe(context.turnState.assistantItemId),
            },
            raw: {
              source: "claude.sdk.message",
              method: "claude/assistant",
              payload: message,
            },
          });
        }

        context.lastAssistantUuid = message.uuid;
        yield* updateResumeCursor(context);
      });

    const handleResultMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "result") {
          return;
        }

        const status = turnStatusFromResult(message);
        const errorMessage = message.subtype === "success" ? undefined : message.errors[0];

        if (status === "failed") {
          yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
        }

        yield* completeTurn(context, status, errorMessage, message);
      });

    const handleSystemMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "system") {
          return;
        }

        const stamp = yield* makeEventStamp();
        const base = {
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.internalThreadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          providerRefs: {
            ...providerThreadRef(context),
            ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
          },
          raw: {
            source: "claude.sdk.message" as const,
            method: sdkNativeMethod(message),
            messageType: `${message.type}:${message.subtype}`,
            payload: message,
          },
        };

        switch (message.subtype) {
          case "init":
            if (Array.isArray((message as Record<string, unknown>).slash_commands)) {
              const commands = (message as Record<string, unknown>).slash_commands as string[];
              context.availableSlashCommands = commands;
              cachedSlashCommands = commands;
            }
            yield* offerRuntimeEvent({
              ...base,
              type: "session.configured",
              payload: {
                config: message as Record<string, unknown>,
              },
            });
            return;
          case "status":
            // After an interrupt or stop, the SDK may still emit late status
            // messages.  Suppress them so they don't flip the orchestration
            // session status back to "running".
            if (context.interrupted || context.stopped) {
              return;
            }
            yield* offerRuntimeEvent({
              ...base,
              type: "session.state.changed",
              payload: {
                state: message.status === "compacting" ? "waiting" : "running",
                reason: `status:${message.status ?? "active"}`,
                detail: message,
              },
            });
            return;
          case "compact_boundary":
            // After compaction old message UUIDs are invalidated. Update
            // lastAssistantUuid to the compact boundary's own UUID so the
            // resume cursor no longer references a stale pre-compaction UUID.
            // Without this the SDK throws "No message found with message.uuid
            // of: <old-uuid>" on the next turn or session resume.
            context.lastAssistantUuid = message.uuid;
            yield* updateResumeCursor(context);

            yield* offerRuntimeEvent({
              ...base,
              type: "thread.state.changed",
              payload: {
                state: "compacted",
                detail: message,
              },
            });
            return;
          case "hook_started":
            yield* offerRuntimeEvent({
              ...base,
              type: "hook.started",
              payload: {
                hookId: message.hook_id,
                hookName: message.hook_name,
                hookEvent: message.hook_event,
              },
            });
            return;
          case "hook_progress":
            yield* offerRuntimeEvent({
              ...base,
              type: "hook.progress",
              payload: {
                hookId: message.hook_id,
                output: message.output,
                stdout: message.stdout,
                stderr: message.stderr,
              },
            });
            return;
          case "hook_response":
            yield* offerRuntimeEvent({
              ...base,
              type: "hook.completed",
              payload: {
                hookId: message.hook_id,
                outcome: message.outcome,
                output: message.output,
                stdout: message.stdout,
                stderr: message.stderr,
                ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
              },
            });
            return;
          case "task_started":
            yield* offerRuntimeEvent({
              ...base,
              type: "task.started",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                description: message.description,
                ...(message.task_type ? { taskType: message.task_type } : {}),
                ...(message.tool_use_id ? { parentToolUseId: message.tool_use_id } : {}),
              },
            });
            return;
          case "task_progress":
            yield* offerRuntimeEvent({
              ...base,
              type: "task.progress",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                description: message.description,
                ...(message.usage ? { usage: message.usage } : {}),
                ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
                ...(message.tool_use_id ? { parentToolUseId: message.tool_use_id } : {}),
              },
            });
            return;
          case "task_notification":
            yield* offerRuntimeEvent({
              ...base,
              type: "task.completed",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                status: message.status,
                ...(message.summary ? { summary: message.summary } : {}),
                ...(message.usage ? { usage: message.usage } : {}),
                ...(message.tool_use_id ? { parentToolUseId: message.tool_use_id } : {}),
              },
            });
            return;
          case "files_persisted":
            yield* offerRuntimeEvent({
              ...base,
              type: "files.persisted",
              payload: {
                files: Array.isArray(message.files)
                  ? message.files.map((file: { filename: string; file_id: string }) => ({
                      filename: file.filename,
                      fileId: file.file_id,
                    }))
                  : [],
                ...(Array.isArray(message.failed)
                  ? {
                      failed: message.failed.map((entry: { filename: string; error: string }) => ({
                        filename: entry.filename,
                        error: entry.error,
                      })),
                    }
                  : {}),
              },
            });
            return;
          case "elicitation_complete":
            // Informational — SDK confirms elicitation was processed.
            // The Deferred was already resolved in respondToUserInput.
            return;
          default:
            yield* emitRuntimeWarning(
              context,
              `Unhandled Claude system message subtype '${message.subtype}'.`,
              message,
            );
            return;
        }
      });

    const handleSdkTelemetryMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const stamp = yield* makeEventStamp();
        const base = {
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.internalThreadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          providerRefs: {
            ...providerThreadRef(context),
            ...(context.turnState ? { providerTurnId: context.turnState.turnId } : {}),
          },
          raw: {
            source: "claude.sdk.message" as const,
            method: sdkNativeMethod(message),
            messageType: message.type,
            payload: message,
          },
        };

        if (message.type === "tool_progress") {
          yield* offerRuntimeEvent({
            ...base,
            type: "tool.progress",
            payload: {
              toolUseId: message.tool_use_id,
              toolName: message.tool_name,
              elapsedSeconds: message.elapsed_time_seconds,
              ...(message.task_id ? { summary: `task:${message.task_id}` } : {}),
            },
          });
          return;
        }

        if (message.type === "tool_use_summary") {
          yield* offerRuntimeEvent({
            ...base,
            type: "tool.summary",
            payload: {
              summary: message.summary,
              ...(message.preceding_tool_use_ids.length > 0
                ? { precedingToolUseIds: message.preceding_tool_use_ids }
                : {}),
            },
          });
          return;
        }

        if (message.type === "auth_status") {
          yield* offerRuntimeEvent({
            ...base,
            type: "auth.status",
            payload: {
              isAuthenticating: message.isAuthenticating,
              output: message.output,
              ...(message.error ? { error: message.error } : {}),
            },
          });
          return;
        }

        if (message.type === "rate_limit_event") {
          yield* offerRuntimeEvent({
            ...base,
            type: "account.rate-limits.updated",
            payload: {
              rateLimits: message.rate_limit_info,
            },
          });
          return;
        }
      });

    const handleSdkMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* logNativeSdkMessage(context, message);
        yield* ensureThreadId(context, message);

        switch (message.type) {
          case "stream_event":
            yield* handleStreamEvent(context, message);
            return;
          case "user":
            return;
          case "assistant":
            yield* handleAssistantMessage(context, message);
            return;
          case "result":
            yield* handleResultMessage(context, message);
            return;
          case "system":
            yield* handleSystemMessage(context, message);
            return;
          case "tool_progress":
          case "tool_use_summary":
          case "auth_status":
          case "rate_limit_event":
            yield* handleSdkTelemetryMessage(context, message);
            return;
          default:
            yield* emitRuntimeWarning(
              context,
              `Unhandled Claude SDK message type '${message.type}'.`,
              message,
            );
            return;
        }
      });

    const runSdkStream = (context: ClaudeSessionContext): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Stream.fromAsyncIterable(context.query, (cause) => cause).pipe(
          Stream.takeWhile(() => !context.stopped),
          Stream.runForEach((message) => handleSdkMessage(context, message)),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterruptsOnly(cause) || context.stopped) {
                return;
              }
              const message = toMessage(Cause.squash(cause), "Claude runtime stream failed.");
              // The Claude CLI emits "NON-FATAL:" errors for benign conditions
              // like lock contention in multi-process scenarios. These are
              // informational and should not surface as failures.
              if (message.includes("NON-FATAL")) {
                return;
              }
              yield* emitRuntimeError(context, message, cause);
              yield* completeTurn(context, "failed", message);
              // Clean up the dead session so subsequent interactions trigger a
              // fresh session start instead of routing to a defunct process.
              yield* stopSessionInternal(context, { exitKind: "error" });
            }),
          ),
        );
      });

    const stopSessionInternal = (
      context: ClaudeSessionContext,
      options?: { readonly emitExitEvent?: boolean; readonly exitKind?: "graceful" | "error" },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (context.stopped) return;

        context.stopped = true;

        for (const [requestId, pending] of context.pendingApprovals) {
          yield* Deferred.succeed(pending.decision, "cancel");
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "request.resolved",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.internalThreadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: {
              requestType: pending.requestType,
              decision: "cancel",
            },
            providerRefs: {
              ...providerThreadRef(context),
              ...(context.turnState ? { providerTurnId: String(context.turnState.turnId) } : {}),
              providerRequestId: requestId,
            },
          });
        }
        context.pendingApprovals.clear();

        for (const [, pending] of context.pendingElicitations) {
          yield* Deferred.succeed(pending.decision, { action: "decline" });
        }
        context.pendingElicitations.clear();

        for (const [, pending] of context.pendingUserQuestions) {
          yield* Deferred.succeed(pending.decision, {});
        }
        context.pendingUserQuestions.clear();

        if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Session stopped.");
        }

        yield* Queue.shutdown(context.promptQueue);

        try {
          context.query.close();
        } catch (err) {
          yield* Effect.logWarning("context.query.close() threw during session stop", {
            threadId: context.internalThreadId,
            error: String(err),
          });
        }

        // Interrupt the SDK stream fiber so it doesn't linger after session cleanup.
        if (context.streamFiber) {
          yield* Fiber.interrupt(context.streamFiber).pipe(Effect.ignore);
          context.streamFiber = undefined;
        }

        const updatedAt = yield* nowIso;
        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt,
        };

        if (options?.emitExitEvent !== false) {
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "session.exited",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.internalThreadId,
            payload: {
              reason: options?.exitKind === "error" ? "Process exited unexpectedly" : "Session stopped",
              exitKind: options?.exitKind ?? "graceful",
            },
            providerRefs: {},
          });
        }

        // Persist final resume cursor before session deletion
        yield* flushPendingCursor(context);
        if (persistResumeCursorCallback && context.pendingCursorWrite === undefined
            && context.session.threadId && context.session.resumeCursor) {
          yield* persistResumeCursorCallback(
            context.session.threadId,
            context.session.resumeCursor,
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to persist final resume cursor on session stop", {
                threadId: context.internalThreadId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        }

        sessions.delete(context.internalThreadId);
      });

    const findSession = (threadId: ThreadId | undefined): ClaudeSessionContext | undefined => {
      if (threadId !== undefined) {
        const direct = sessions.get(threadId);
        if (direct) return direct;
      }
      for (const ctx of sessions.values()) {
        if (ctx.internalThreadId === threadId || ctx.session.threadId === threadId) {
          return ctx;
        }
      }
      // When threadId is undefined, return the sole active session if exactly
      // one exists. This handles the case where the caller obtained a session
      // whose provider threadId was not yet assigned.
      if (threadId === undefined && sessions.size === 1) {
        const [only] = sessions.values();
        return only;
      }
      return undefined;
    };

    const requireSession = (
      threadId: ThreadId | undefined,
    ): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> => {
      const context = findSession(threadId);
      const errorThreadId = threadId ?? ThreadId.makeUnsafe("<unknown>");
      if (!context) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: errorThreadId,
          }),
        );
      }
      if (context.stopped || context.session.status === "closed") {
        return Effect.fail(
          new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId: errorThreadId,
          }),
        );
      }
      return Effect.succeed(context);
    };

    // Mapping functions are defined at module level for testability.
    // See: mapElicitationToUserInputQuestions, mapAnswersToElicitationContent

    const startSession: ClaudeCodeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const startedAt = yield* nowIso;
        const resumeState = readClaudeResumeState(input.resumeCursor);
        const internalThreadId = input.threadId;
        const providerThreadId = resumeState?.threadId ?? undefined;
        const threadId = internalThreadId;

        const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
        const prompt = yield* Stream.fromQueue(promptQueue).pipe(
          Stream.filter((item) => item.type === "message"),
          Stream.map((item) => item.message),
          Stream.toAsyncIterableEffect,
        );

        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        const inFlightTools = new Map<number, ToolInFlight>();

        const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);

        const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const context = yield* Ref.get(contextRef);
              if (!context) {
                return {
                  behavior: "deny",
                  message: "Claude session context is unavailable.",
                } satisfies PermissionResult;
              }

              // AskUserQuestion: surface to UI and wait for user answers
              if (toolName === "AskUserQuestion") {
                const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
                const decisionDeferred = yield* Deferred.make<Record<string, string>>();
                const questions = mapAskUserQuestionToUserInputQuestions(toolInput);

                const pending: PendingUserQuestion = {
                  requestId,
                  toolInput,
                  decision: decisionDeferred,
                };

                const stamp = yield* makeEventStamp();
                const userInputEvent: ProviderRuntimeEvent = {
                  type: "user-input.requested",
                  eventId: stamp.eventId,
                  provider: PROVIDER,
                  createdAt: stamp.createdAt,
                  threadId: context.internalThreadId,
                  ...(context.turnState
                    ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                    : {}),
                  requestId: asRuntimeRequestId(requestId),
                  payload: { questions },
                  providerRefs: {
                    ...providerThreadRef(context),
                    ...(context.turnState
                      ? { providerTurnId: String(context.turnState.turnId) }
                      : {}),
                    providerRequestId: requestId,
                  },
                  raw: {
                    source: "claude.sdk.permission",
                    method: "canUseTool/AskUserQuestion",
                    payload: { toolName, input: toolInput },
                  },
                };
                yield* offerRuntimeEvent(userInputEvent);
                yield* offerApprovalEvent(userInputEvent);

                context.pendingUserQuestions.set(requestId, pending);

                const onAbort = () => {
                  if (!context.pendingUserQuestions.has(requestId)) return;
                  context.pendingUserQuestions.delete(requestId);
                  Effect.runFork(Deferred.succeed(decisionDeferred, {}));
                };
                callbackOptions.signal.addEventListener("abort", onAbort, { once: true });

                const answers = yield* Deferred.await(decisionDeferred);
                callbackOptions.signal.removeEventListener("abort", onAbort);
                context.pendingUserQuestions.delete(requestId);

                return {
                  behavior: "allow",
                  updatedInput: { ...toolInput, answers },
                } satisfies PermissionResult;
              }

              // Plan-mode server-side enforcement: block mutating tools while
              // allowing read-only exploration. The SDK's setPermissionMode("plan")
              // should prevent mutations, but if it doesn't we must block them
              // here to avoid executing the plan instead of just proposing it.
              if (context.turnState?.isPlanMode) {
                const lower = toolName.toLowerCase();
                const isReadOnly =
                  lower === "read" ||
                  lower === "grep" ||
                  lower === "glob" ||
                  lower === "websearch" ||
                  lower === "web_search" ||
                  lower === "webfetch" ||
                  lower === "web_fetch" ||
                  lower === "toolsearch" ||
                  lower === "view";
                if (!isReadOnly) {
                  return {
                    behavior: "deny",
                    message:
                      "Tool execution is not allowed in plan mode. Read-only tools (Read, Grep, Glob) are permitted for exploration. Describe the plan without executing changes.",
                  } satisfies PermissionResult;
                }
              }

              const runtimeMode = input.runtimeMode ?? "full-access";
              if (runtimeMode === "full-access") {
                return {
                  behavior: "allow",
                  updatedInput: toolInput,
                } satisfies PermissionResult;
              }

              const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
              const requestType = classifyRequestType(toolName);
              const detail = summarizeToolRequest(toolName, toolInput);
              const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
              const pendingApproval: PendingApproval = {
                requestType,
                detail,
                decision: decisionDeferred,
                ...(callbackOptions.suggestions
                  ? { suggestions: callbackOptions.suggestions }
                  : {}),
              };

              const requestedStamp = yield* makeEventStamp();
              const approvalEvent: ProviderRuntimeEvent = {
                type: "request.opened",
                eventId: requestedStamp.eventId,
                provider: PROVIDER,
                createdAt: requestedStamp.createdAt,
                threadId: context.internalThreadId,
                ...(context.turnState
                  ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                  : {}),
                requestId: asRuntimeRequestId(requestId),
                payload: {
                  requestType,
                  detail,
                  args: {
                    toolName,
                    input: toolInput,
                    ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
                  },
                },
                providerRefs: {
                  ...(context.session.threadId
                    ? { providerThreadId: context.session.threadId }
                    : {}),
                  ...(context.turnState
                    ? { providerTurnId: String(context.turnState.turnId) }
                    : {}),
                  providerRequestId: requestId,
                },
                raw: {
                  source: "claude.sdk.permission",
                  method: "canUseTool/request",
                  payload: {
                    toolName,
                    input: toolInput,
                  },
                },
              };
              yield* offerRuntimeEvent(approvalEvent);
              yield* offerApprovalEvent(approvalEvent);

              pendingApprovals.set(requestId, pendingApproval);

              const onAbort = () => {
                if (!pendingApprovals.has(requestId)) {
                  return;
                }
                pendingApprovals.delete(requestId);
                Effect.runFork(Deferred.succeed(decisionDeferred, "cancel"));
              };

              callbackOptions.signal.addEventListener("abort", onAbort, {
                once: true,
              });

              const decision = yield* Deferred.await(decisionDeferred);
              callbackOptions.signal.removeEventListener("abort", onAbort);
              pendingApprovals.delete(requestId);

              const resolvedStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                type: "request.resolved",
                eventId: resolvedStamp.eventId,
                provider: PROVIDER,
                createdAt: resolvedStamp.createdAt,
                threadId: context.internalThreadId,
                ...(context.turnState
                  ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                  : {}),
                requestId: asRuntimeRequestId(requestId),
                payload: {
                  requestType,
                  decision,
                },
                providerRefs: {
                  ...(context.session.threadId
                    ? { providerThreadId: context.session.threadId }
                    : {}),
                  ...(context.turnState
                    ? { providerTurnId: String(context.turnState.turnId) }
                    : {}),
                  providerRequestId: requestId,
                },
                raw: {
                  source: "claude.sdk.permission",
                  method: "canUseTool/decision",
                  payload: {
                    decision,
                  },
                },
              });

              if (decision === "accept" || decision === "acceptForSession") {
                return {
                  behavior: "allow",
                  updatedInput: toolInput,
                  ...(decision === "acceptForSession" && pendingApproval.suggestions
                    ? { updatedPermissions: [...pendingApproval.suggestions] }
                    : {}),
                } satisfies PermissionResult;
              }

              return {
                behavior: "deny",
                message:
                  decision === "cancel"
                    ? "User cancelled tool execution."
                    : "User declined tool execution.",
              } satisfies PermissionResult;
            }).pipe(
              Effect.catchCause(() =>
                Effect.succeed({
                  behavior: "deny",
                  message: "Internal error processing tool permission request.",
                } satisfies PermissionResult),
              ),
            ),
          );

        const handleElicitation: OnElicitation = (request, callbackOptions) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const context = yield* Ref.get(contextRef);
              if (!context || context.stopped) {
                return { action: "decline" } satisfies ElicitationResult;
              }

              const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
              const decisionDeferred = yield* Deferred.make<ElicitationResult>();

              const questions = mapElicitationToUserInputQuestions(request);

              const pending: PendingElicitation = {
                requestId,
                serverName: request.serverName,
                message: request.message,
                mode: request.mode,
                requestedSchema: request.requestedSchema,
                decision: decisionDeferred,
              };

              const stamp = yield* makeEventStamp();
              const elicitationEvent: ProviderRuntimeEvent = {
                type: "user-input.requested",
                eventId: stamp.eventId,
                provider: PROVIDER,
                createdAt: stamp.createdAt,
                threadId: context.internalThreadId,
                ...(context.turnState
                  ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                  : {}),
                requestId: asRuntimeRequestId(requestId),
                payload: {
                  questions,
                },
                providerRefs: {
                  ...providerThreadRef(context),
                  ...(context.turnState
                    ? { providerTurnId: String(context.turnState.turnId) }
                    : {}),
                  providerRequestId: requestId,
                },
                raw: {
                  source: "claude.sdk.elicitation",
                  method: "onElicitation/request",
                  payload: {
                    serverName: request.serverName,
                    message: request.message,
                    mode: request.mode,
                    elicitationId: request.elicitationId,
                  },
                },
              };
              yield* offerRuntimeEvent(elicitationEvent);
              yield* offerApprovalEvent(elicitationEvent);

              context.pendingElicitations.set(requestId, pending);

              const onAbort = () => {
                if (!context.pendingElicitations.has(requestId)) return;
                context.pendingElicitations.delete(requestId);
                Effect.runFork(Deferred.succeed(decisionDeferred, { action: "decline" }));
              };
              callbackOptions.signal.addEventListener("abort", onAbort, { once: true });

              const result = yield* Deferred.await(decisionDeferred);
              callbackOptions.signal.removeEventListener("abort", onAbort);
              context.pendingElicitations.delete(requestId);
              return result;
            }).pipe(
              Effect.catchCause(() =>
                Effect.succeed({ action: "decline" } satisfies ElicitationResult),
              ),
            ),
          );

        const providerOptions = input.providerOptions?.claudeCode;
        const permissionMode =
          toPermissionMode(providerOptions?.permissionMode) ??
          (input.runtimeMode === "full-access" ? "bypassPermissions" : undefined);

        const claudeBinaryPath = providerOptions?.binaryPath ?? resolveClaudeBinaryPath();

        const queryOptions: ClaudeQueryOptions = {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(claudeBinaryPath ? { pathToClaudeCodeExecutable: claudeBinaryPath } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(permissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          ...(providerOptions?.maxThinkingTokens !== undefined
            ? { maxThinkingTokens: providerOptions.maxThinkingTokens }
            : {}),
          ...(input.modelOptions?.claudeCode?.effort
            ? { effort: input.modelOptions.claudeCode.effort }
            : {}),
          ...(resumeState?.resume ? { resume: resumeState.resume } : {}),
          ...(resumeState?.resumeSessionAt ? { resumeSessionAt: resumeState.resumeSessionAt } : {}),
          includePartialMessages: true,
          canUseTool,
          onElicitation: handleElicitation,
          toolConfig: { askUserQuestion: { previewFormat: "html" } },
          env: sanitizedProcessEnv(),
          ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
          // Load all filesystem settings so custom skills, plugins, CLAUDE.md,
          // and user preferences are available in SDK sessions.
          settingSources: ["user", "project", "local"],
        };

        const queryRuntime = yield* Effect.try({
          try: () =>
            createQuery({
              prompt,
              options: queryOptions,
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: toMessage(cause, "Failed to start Claude runtime session."),
              cause,
            }),
        });

        const session: ProviderSession = {
          threadId: providerThreadId,
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.model ? { model: input.model } : {}),
          resumeCursor: {
            ...(providerThreadId ? { threadId: providerThreadId } : {}),
            ...(resumeState?.resume ? { resume: resumeState.resume } : {}),
            ...(resumeState?.resumeSessionAt
              ? { resumeSessionAt: resumeState.resumeSessionAt }
              : {}),
            turnCount: resumeState?.turnCount ?? 0,
          },
          createdAt: startedAt,
          updatedAt: startedAt,
        };

        const context: ClaudeSessionContext = {
          internalThreadId,
          session,
          promptQueue,
          query: queryRuntime,
          startedAt,
          basePermissionMode: permissionMode ?? "default",
          resumeSessionId: resumeState?.resume,
          pendingApprovals,
          pendingElicitations: new Map<ApprovalRequestId, PendingElicitation>(),
          pendingUserQuestions: new Map<ApprovalRequestId, PendingUserQuestion>(),
          turns: [],
          inFlightTools,
          turnState: undefined,
          lastAssistantUuid: resumeState?.resumeSessionAt,
          lastThreadStartedId: undefined,
          stopped: false,
          interrupted: false,
          lastPersistedCursorAt: 0,
          pendingCursorWrite: undefined,
          availableSlashCommands: [],
          streamFiber: undefined,
        };
        yield* Ref.set(contextRef, context);
        sessions.set(threadId, context);

        const sessionStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.started",
          eventId: sessionStartedStamp.eventId,
          provider: PROVIDER,
          createdAt: sessionStartedStamp.createdAt,
          threadId: internalThreadId,
          payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
          providerRefs: {},
        });

        const configuredStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.configured",
          eventId: configuredStamp.eventId,
          provider: PROVIDER,
          createdAt: configuredStamp.createdAt,
          threadId: internalThreadId,
          payload: {
            config: {
              ...(input.model ? { model: input.model } : {}),
              ...(input.cwd ? { cwd: input.cwd } : {}),
              ...(permissionMode ? { permissionMode } : {}),
              ...(providerOptions?.maxThinkingTokens !== undefined
                ? { maxThinkingTokens: providerOptions.maxThinkingTokens }
                : {}),
            },
          },
          providerRefs: {},
        });

        const readyStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          eventId: readyStamp.eventId,
          provider: PROVIDER,
          createdAt: readyStamp.createdAt,
          threadId: internalThreadId,
          payload: {
            state: "ready",
          },
          providerRefs: {},
        });

        context.streamFiber = Effect.runFork(runSdkStream(context));

        return {
          ...session,
        };
      });

    const sendTurn: ClaudeCodeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);

        if (context.turnState) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Thread '${input.threadId}' already has an active turn '${context.turnState.turnId}'.`,
          });
        }

        if (input.model) {
          yield* Effect.tryPromise({
            try: () => context.query.setModel(input.model),
            catch: (cause) => toRequestError(input.threadId, "turn/setModel", cause),
          });
        }

        if (input.interactionMode) {
          const targetMode: PermissionMode =
            input.interactionMode === "plan" ? "plan" : context.basePermissionMode;
          yield* Effect.tryPromise({
            try: () => context.query.setPermissionMode(targetMode),
            catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
          });
        }

        // Re-verify the session is still alive after the async model/permission
        // calls above — stopSessionInternal could have run concurrently.
        if (context.stopped) {
          return yield* new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }

        const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
        const turnState: ClaudeTurnState = {
          turnId,
          assistantItemId: yield* Random.nextUUIDv4,
          startedAt: yield* nowIso,
          items: [],
          messageCompleted: false,
          emittedTextDelta: false,
          fallbackAssistantText: "",
          lastBlockWasToolUse: false,
          isPlanMode: input.interactionMode === "plan",
        };

        const updatedAt = yield* nowIso;
        context.turnState = turnState;
        // Clear interrupted flag from a previous interrupt so SDK status
        // messages for the new turn are processed normally.
        context.interrupted = false;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt,
        };

        const turnStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.started",
          eventId: turnStartedStamp.eventId,
          provider: PROVIDER,
          createdAt: turnStartedStamp.createdAt,
          threadId: context.internalThreadId,
          turnId,
          payload: input.model ? { model: input.model } : {},
          providerRefs: {
            providerTurnId: String(turnId),
          },
        });

        const message = buildUserMessage(input);
        yield* Queue.offer(context.promptQueue, {
          type: "message",
          message,
        }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)));
        return {
          threadId: context.internalThreadId,
          turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        };
      });

    const interruptTurn: ClaudeCodeAdapterShape["interruptTurn"] = (threadId, _turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* Effect.tryPromise({
          try: () => context.query.interrupt(),
          catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
        }).pipe(
          Effect.timeout("5 seconds"),
          Effect.catchCause((cause) =>
            Effect.logWarning("SDK interrupt() timed out or failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
        // Eagerly mark the session as no longer running so that late-arriving
        // SDK status messages (session.state.changed with state "running")
        // emitted after the interrupt don't flip the orchestration status back
        // to "running".  The adapter-level `interrupted` flag is checked in
        // handleSystemMessage before emitting session.state.changed events.
        context.interrupted = true;

        // Watchdog: if the SDK doesn't emit a result message within 10s after
        // interrupt, force-complete the turn so the session doesn't stay stuck.
        if (context.turnState) {
          const turnIdAtInterrupt = context.turnState.turnId;
          Effect.runFork(
            Effect.gen(function* () {
              yield* Effect.sleep("10 seconds");
              if (context.turnState?.turnId === turnIdAtInterrupt) {
                yield* Effect.logWarning(
                  "Interrupt watchdog: turn did not complete within timeout, force-completing",
                  { threadId, turnId: turnIdAtInterrupt },
                );
                yield* completeTurn(context, "interrupted", "Interrupt timed out — turn force-completed");
              }
            }).pipe(Effect.ignore),
          );
        }
      });

    const readThread: ClaudeCodeAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        return yield* snapshotThread(context);
      });

    const rollbackThread: ClaudeCodeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const nextLength = Math.max(0, context.turns.length - numTurns);
        context.turns.splice(nextLength);
        yield* updateResumeCursor(context);
        return yield* snapshotThread(context);
      });

    const respondToRequest: ClaudeCodeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/requestApproval/decision",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }

        context.pendingApprovals.delete(requestId);
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ClaudeCodeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);

        // Check pending user questions (AskUserQuestion tool) first
        const pendingQuestion = context.pendingUserQuestions.get(requestId);
        if (pendingQuestion) {
          context.pendingUserQuestions.delete(requestId);
          yield* Deferred.succeed(pendingQuestion.decision, answers as Record<string, string>);

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "user-input.resolved",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.internalThreadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: { answers },
            providerRefs: {
              ...providerThreadRef(context),
              ...(context.turnState ? { providerTurnId: String(context.turnState.turnId) } : {}),
              providerRequestId: requestId,
            },
            raw: {
              source: "claude.sdk.permission",
              method: "canUseTool/AskUserQuestion/response",
              payload: { answers },
            },
          });
          return;
        }

        // Check pending elicitations (MCP elicitation)
        const pending = context.pendingElicitations.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/tool/requestUserInput",
            detail: `Unknown pending user input request: ${requestId}`,
          });
        }

        const content = mapAnswersToElicitationContent(
          answers as Record<string, unknown>,
          pending.requestedSchema,
        );

        context.pendingElicitations.delete(requestId);
        yield* Deferred.succeed(pending.decision, {
          action: "accept",
          content: content as { [x: string]: string | number | boolean | string[] },
        });

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "user-input.resolved",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.internalThreadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: {
            answers: content,
          },
          providerRefs: {
            ...providerThreadRef(context),
            ...(context.turnState ? { providerTurnId: String(context.turnState.turnId) } : {}),
            providerRequestId: requestId,
          },
          raw: {
            source: "claude.sdk.elicitation",
            method: "onElicitation/response",
            payload: { answers: content },
          },
        });
      });

    const stopSession: ClaudeCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* stopSessionInternal(context, {
          emitExitEvent: true,
        });
      });

    const listSessions: ClaudeCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

    const hasSession: ClaudeCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const context = findSession(threadId);
        return context !== undefined && !context.stopped;
      });

    const getSlashCommands: ClaudeCodeAdapterShape["getSlashCommands"] = (threadId) =>
      Effect.sync(() => {
        const context = findSession(threadId);
        return context?.availableSlashCommands ?? [];
      });

    const getCachedSlashCommands: ClaudeCodeAdapterShape["getCachedSlashCommands"] = () =>
      Effect.sync(() => cachedSlashCommands);

    const mcpGetStatus: ClaudeCodeAdapterShape["mcpGetStatus"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const statuses = yield* Effect.tryPromise({
          try: () => context.query.mcpServerStatus(),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "mcp/getStatus",
              detail: toMessage(cause, "Failed to get MCP server status"),
            }),
        });
        return statuses as unknown as ReadonlyArray<McpServerStatus>;
      });

    const mcpSetServers: ClaudeCodeAdapterShape["mcpSetServers"] = (threadId, servers) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const result = yield* Effect.tryPromise({
          try: () => context.query.setMcpServers(servers),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "mcp/setServers",
              detail: toMessage(cause, "Failed to set MCP servers"),
            }),
        });
        return result as unknown as McpSetServersResult;
      });

    const mcpReconnectServer: ClaudeCodeAdapterShape["mcpReconnectServer"] = (
      threadId,
      serverName,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* Effect.tryPromise({
          try: () => context.query.reconnectMcpServer(serverName),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "mcp/reconnect",
              detail: toMessage(cause, `Failed to reconnect MCP server '${serverName}'`),
            }),
        });
      });

    const mcpToggleServer: ClaudeCodeAdapterShape["mcpToggleServer"] = (
      threadId,
      serverName,
      enabled,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* Effect.tryPromise({
          try: () => context.query.toggleMcpServer(serverName, enabled),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "mcp/toggle",
              detail: toMessage(cause, `Failed to toggle MCP server '${serverName}'`),
            }),
        });
      });

    const stopAll: ClaudeCodeAdapterShape["stopAll"] = () =>
      Effect.forEach(
        sessions,
        ([, context]) =>
          stopSessionInternal(context, {
            emitExitEvent: true,
          }),
        { discard: true },
      );

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        sessions,
        ([, context]) =>
          stopSessionInternal(context, {
            emitExitEvent: false,
          }),
        { discard: true },
      ).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      getSlashCommands,
      getCachedSlashCommands,
      mcpGetStatus,
      mcpSetServers,
      mcpReconnectServer,
      mcpToggleServer,
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
      streamApprovalEvents: Stream.fromPubSub(approvalEventPubSub),
    } satisfies ClaudeCodeAdapterShape;
  });
}

export function mapAskUserQuestionToUserInputQuestions(toolInput: Record<string, unknown>): Array<{
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
}> {
  const questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  if (questions.length === 0) {
    return [{ id: "question", header: "Question", question: "Please respond", options: [] }];
  }

  return questions.map((q: Record<string, unknown>, index: number) => {
    const question = typeof q.question === "string" ? q.question : `Question ${index + 1}`;
    const header = typeof q.header === "string" ? q.header : "Question";
    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const options = rawOptions
      .filter(
        (opt: unknown): opt is Record<string, unknown> => typeof opt === "object" && opt !== null,
      )
      .map((opt: Record<string, unknown>) => ({
        label: typeof opt.label === "string" ? opt.label : "",
        description: typeof opt.description === "string" ? opt.description : "",
      }))
      .filter((opt) => opt.label.length > 0);

    // Use question text as id — matches the SDK's expected answer key format
    return { id: question, header, question, options };
  });
}

export function mapElicitationToUserInputQuestions(request: {
  serverName: string;
  message: string;
  requestedSchema?: Record<string, unknown>;
}): Array<{
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
}> {
  const header = `MCP: ${request.serverName}`;
  const schema = request.requestedSchema;

  if (!schema || typeof schema !== "object") {
    return [{ id: "elicitation", header, question: request.message, options: [] }];
  }

  const properties = (schema as Record<string, unknown>).properties;
  if (!properties || typeof properties !== "object") {
    return [{ id: "elicitation", header, question: request.message, options: [] }];
  }

  const entries = Object.entries(properties as Record<string, Record<string, unknown>>);
  if (entries.length === 0) {
    return [{ id: "elicitation", header, question: request.message, options: [] }];
  }

  const hasComplexFeatures = entries.some(([, prop]) => {
    const propType = prop.type;
    return (
      prop.oneOf !== undefined ||
      prop.allOf !== undefined ||
      prop.anyOf !== undefined ||
      prop.$ref !== undefined ||
      propType === "object" ||
      propType === "array"
    );
  });

  if (hasComplexFeatures) {
    return [{ id: "elicitation", header, question: request.message, options: [] }];
  }

  return entries.map(([key, prop]) => {
    const question = (prop.description as string) ?? (prop.title as string) ?? key;
    const enumValues = Array.isArray(prop.enum) ? prop.enum : [];
    const options = enumValues
      .filter((v): v is string => typeof v === "string")
      .map((v) => ({ label: v, description: v }));
    return { id: key, header, question, options };
  });
}

export function mapAnswersToElicitationContent(
  answers: Record<string, unknown>,
  requestedSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!requestedSchema) return { ...answers };

  const properties = (requestedSchema as Record<string, unknown>).properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) return { ...answers };

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    const prop = properties[key];
    if (!prop || typeof value !== "string") {
      result[key] = value;
      continue;
    }

    if (prop.type === "boolean") {
      result[key] = value === "true";
      continue;
    }

    if (prop.type === "number" || prop.type === "integer") {
      const num = Number(value);
      result[key] = Number.isNaN(num) ? value : num;
      continue;
    }

    result[key] = value;
  }
  return result;
}

export const ClaudeCodeAdapterLive = Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter());

export function makeClaudeCodeAdapterLive(options?: ClaudeCodeAdapterLiveOptions) {
  return Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter(options));
}
