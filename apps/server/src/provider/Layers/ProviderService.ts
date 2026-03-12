/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  EventId,
  NonNegativeInt,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type McpServerStatus,
  type McpSetServersResult,
} from "@t3tools/contracts";
import { Effect, Layer, Option, PubSub, Schema, SchemaIssue, Stream } from "effect";

import { ProviderValidationError } from "../Errors.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";

export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogPath?: string;
  readonly canonicalEventLogger?: EventNdjsonLogger;
}

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) =>
  Schema.decodeUnknownEffect(input.schema)(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: { readonly providerOptions?: unknown },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.providerOptions !== undefined ? { providerOptions: extra.providerOptions } : {}),
  };
}

function readPersistedProviderOptions(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): Record<string, unknown> | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "providerOptions" in runtimePayload ? runtimePayload.providerOptions : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

function readPersistedCwd(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const makeProviderService = (options?: ProviderServiceLiveOptions) =>
  Effect.gen(function* () {
    const analytics = yield* Effect.service(AnalyticsService);
    const canonicalEventLogger =
      options?.canonicalEventLogger ??
      (options?.canonicalEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.canonicalEventLogPath, {
            stream: "canonical",
          })
        : undefined);

    const registry = yield* ProviderAdapterRegistry;
    const directory = yield* ProviderSessionDirectory;
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Publish to subscribers immediately — don't block fan-out on disk I/O.
        yield* PubSub.publish(runtimeEventPubSub, event);
        // Fire-and-forget canonical log write so it never stalls the pipeline.
        if (canonicalEventLogger) {
          yield* Effect.forkDetach(canonicalEventLogger.write(event, null));
        }
      });

    const upsertSessionBinding = (
      session: ProviderSession,
      threadId: ThreadId,
      extra?: { readonly providerOptions?: unknown },
    ) =>
      directory.upsert({
        threadId,
        provider: session.provider,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });

    const providers = yield* registry.listProviders();
    const adapters = yield* Effect.forEach(providers, (provider) =>
      registry.getByProvider(provider),
    );

    // Each adapter gets its own fiber — events from different adapters
    // are processed in parallel instead of funnelling through one queue.
    yield* Effect.forEach(adapters, (adapter) =>
      Stream.runForEach(adapter.streamEvents, publishRuntimeEvent).pipe(Effect.forkScoped),
    ).pipe(Effect.asVoid);

    // Merge approval fast-path streams from all adapters that support them.
    const approvalStreams = adapters
      .filter(
        (a): a is typeof a & { streamApprovalEvents: Stream.Stream<ProviderRuntimeEvent> } =>
          a.streamApprovalEvents !== undefined,
      )
      .map((a) => a.streamApprovalEvents);
    const mergedApprovalStream =
      approvalStreams.length > 0
        ? Stream.mergeAll(approvalStreams, { concurrency: "unbounded" })
        : undefined;

    const recoverSessionForThread = (input: {
      readonly binding: ProviderRuntimeBinding;
      readonly operation: string;
    }) =>
      Effect.gen(function* () {
        const adapter = yield* registry.getByProvider(input.binding.provider);
        const hasResumeCursor =
          input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
        const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
        if (hasActiveSession) {
          const activeSessions = yield* adapter.listSessions();
          const existing = activeSessions.find(
            (session) => session.threadId === input.binding.threadId,
          );
          if (existing) {
            yield* upsertSessionBinding(existing, input.binding.threadId);
            yield* analytics.record("provider.session.recovered", {
              provider: existing.provider,
              strategy: "adopt-existing",
              hasResumeCursor: existing.resumeCursor !== undefined,
            });
            return { adapter, session: existing } as const;
          }
        }

        if (!hasResumeCursor) {
          return yield* toValidationError(
            input.operation,
            `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
          );
        }

        const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
        const persistedProviderOptions = readPersistedProviderOptions(input.binding.runtimePayload);

        const baseStartInput = {
          threadId: input.binding.threadId,
          provider: input.binding.provider,
          ...(persistedCwd ? { cwd: persistedCwd } : {}),
          ...(persistedProviderOptions ? { providerOptions: persistedProviderOptions } : {}),
          runtimeMode: input.binding.runtimeMode ?? "full-access",
        };

        const startEffect = adapter.startSession({
          ...baseStartInput,
          ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
        });

        // When a resume cursor is present, the persisted state may be stale
        // (e.g. server crashed before cleanup). If resuming fails, fall back
        // to a fresh session so the thread remains usable.
        const resumed = hasResumeCursor
          ? yield* startEffect.pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  yield* Effect.logWarning(
                    "Session resume failed with persisted cursor; retrying fresh start",
                    { threadId: input.binding.threadId, error },
                  );
                  // Clear stale cursor before fresh start
                  // MUST use null, not undefined -- undefined means "keep existing" in directory.upsert()
                  yield* directory.upsert({
                    threadId: input.binding.threadId,
                    provider: input.binding.provider,
                    runtimeMode: input.binding.runtimeMode ?? "full-access",
                    resumeCursor: null,
                    runtimePayload: input.binding.runtimePayload,
                  });
                  return yield* adapter.startSession(baseStartInput);
                }),
              ),
            )
          : yield* startEffect;
        if (resumed.provider !== adapter.provider) {
          return yield* toValidationError(
            input.operation,
            `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
          );
        }

        yield* upsertSessionBinding(resumed, input.binding.threadId);

        // Determine recovery strategy for the context-reset event
        const recoveryStrategy = hasResumeCursor
          ? (resumed.resumeCursor !== undefined ? "resumed" : "fresh-start")
          : "fresh-start";

        yield* analytics.record("provider.session.recovered", {
          provider: resumed.provider,
          strategy: "resume-thread",
          hasResumeCursor: resumed.resumeCursor !== undefined,
        });

        // Emit session.context-reset event
        const eventId = EventId.makeUnsafe(crypto.randomUUID());
        const createdAt = new Date().toISOString();
        const priorTurnCount =
          input.binding.resumeCursor &&
          typeof input.binding.resumeCursor === "object" &&
          input.binding.resumeCursor !== null &&
          "turnCount" in input.binding.resumeCursor &&
          typeof (input.binding.resumeCursor as Record<string, unknown>).turnCount === "number"
            ? ((input.binding.resumeCursor as Record<string, unknown>).turnCount as number)
            : undefined;
        yield* publishRuntimeEvent({
          type: "session.context-reset",
          eventId,
          provider: resumed.provider,
          threadId: input.binding.threadId,
          createdAt,
          payload: {
            reason: "Session recovered after process death",
            strategy: recoveryStrategy,
            ...(priorTurnCount !== undefined ? { priorTurnCount } : {}),
          },
          providerRefs: {},
        });

        return { adapter, session: resumed } as const;
      });

    const resolveRoutableSession = (input: {
      readonly threadId: ThreadId;
      readonly operation: string;
      readonly allowRecovery: boolean;
    }) =>
      Effect.gen(function* () {
        const bindingOption = yield* directory.getBinding(input.threadId);
        const binding = Option.getOrUndefined(bindingOption);
        if (!binding) {
          return yield* toValidationError(
            input.operation,
            `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
          );
        }
        const adapter = yield* registry.getByProvider(binding.provider);

        const hasRequestedSession = yield* adapter.hasSession(input.threadId);
        if (hasRequestedSession) {
          return { adapter, threadId: input.threadId, isActive: true } as const;
        }

        if (!input.allowRecovery) {
          return { adapter, threadId: input.threadId, isActive: false } as const;
        }

        const recovered = yield* recoverSessionForThread({ binding, operation: input.operation });
        return { adapter: recovered.adapter, threadId: input.threadId, isActive: true } as const;
      });

    const startSession: ProviderServiceShape["startSession"] = (threadId, rawInput) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.startSession",
          schema: ProviderSessionStartInput,
          payload: rawInput,
        });

        const input = {
          ...parsed,
          threadId,
          provider: parsed.provider ?? "codex",
        };
        const adapter = yield* registry.getByProvider(input.provider);
        const session = yield* adapter.startSession(input);

        if (session.provider !== adapter.provider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }

        yield* upsertSessionBinding(session, threadId, {
          ...(input.providerOptions !== undefined
            ? { providerOptions: input.providerOptions }
            : {}),
        });
        yield* analytics.record("provider.session.started", {
          provider: session.provider,
          runtimeMode: input.runtimeMode,
          hasResumeCursor: session.resumeCursor !== undefined,
          hasCwd: typeof input.cwd === "string" && input.cwd.trim().length > 0,
          hasModel: typeof input.model === "string" && input.model.trim().length > 0,
        });

        return session;
      });

    const sendTurn: ProviderServiceShape["sendTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.sendTurn",
          schema: ProviderSendTurnInput,
          payload: rawInput,
        });

        const input = {
          ...parsed,
          attachments: parsed.attachments ?? [],
        };
        if (!input.input && input.attachments.length === 0) {
          return yield* toValidationError(
            "ProviderService.sendTurn",
            "Either input text or at least one attachment is required",
          );
        }
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.sendTurn",
          allowRecovery: true,
        });
        const turn = yield* routed.adapter.sendTurn(input);
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          status: "running",
          ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
          runtimePayload: {
            activeTurnId: turn.turnId,
            lastRuntimeEvent: "provider.sendTurn",
            lastRuntimeEventAt: new Date().toISOString(),
          },
        });
        yield* analytics.record("provider.turn.sent", {
          provider: routed.adapter.provider,
          model: input.model,
          interactionMode: input.interactionMode,
          attachmentCount: input.attachments.length,
          hasInput: typeof input.input === "string" && input.input.trim().length > 0,
        });
        return turn;
      });

    const interruptTurn: ProviderServiceShape["interruptTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.interruptTurn",
          schema: ProviderInterruptTurnInput,
          payload: rawInput,
        });
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          // Don't recover — if the adapter lost the session, there is no running
          // turn to interrupt and spawning a new session just to call interrupt()
          // on it creates zombie processes.
          allowRecovery: false,
        });
        if (!routed.isActive) {
          yield* Effect.logWarning("interruptTurn: no active adapter session, skipping interrupt", {
            threadId: input.threadId,
          });
          return;
        }
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      });

    const respondToRequest: ProviderServiceShape["respondToRequest"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.respondToRequest",
          schema: ProviderRespondToRequestInput,
          payload: rawInput,
        });
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      });

    const respondToUserInput: ProviderServiceShape["respondToUserInput"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.respondToUserInput",
          schema: ProviderRespondToUserInputInput,
          payload: rawInput,
        });
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToUserInput",
          allowRecovery: true,
        });
        yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
      });

    const stopSession: ProviderServiceShape["stopSession"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.stopSession",
          schema: ProviderStopSessionInput,
          payload: rawInput,
        });
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        yield* directory.remove(input.threadId);
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
      });

    const listSessions: ProviderServiceShape["listSessions"] = () =>
      Effect.gen(function* () {
        const sessionsByProvider = yield* Effect.forEach(adapters, (adapter) =>
          adapter.listSessions(),
        );
        const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
        const persistedBindings = yield* directory.listThreadIds().pipe(
          Effect.flatMap((threadIds) =>
            Effect.forEach(
              threadIds,
              (threadId) =>
                directory
                  .getBinding(threadId)
                  .pipe(Effect.orElseSucceed(() => Option.none<ProviderRuntimeBinding>())),
              { concurrency: "unbounded" },
            ),
          ),
          Effect.orElseSucceed(() => [] as Array<Option.Option<ProviderRuntimeBinding>>),
        );
        const bindingsByThreadId = new Map<ThreadId, ProviderRuntimeBinding>();
        for (const bindingOption of persistedBindings) {
          const binding = Option.getOrUndefined(bindingOption);
          if (binding) {
            bindingsByThreadId.set(binding.threadId, binding);
          }
        }

        return activeSessions.map((session) => {
          const binding = bindingsByThreadId.get(session.threadId!);
          if (!binding) {
            return session;
          }

          const overrides: {
            resumeCursor?: ProviderSession["resumeCursor"];
            runtimeMode?: ProviderSession["runtimeMode"];
          } = {};
          if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
            overrides.resumeCursor = binding.resumeCursor;
          }
          if (binding.runtimeMode !== undefined) {
            overrides.runtimeMode = binding.runtimeMode;
          }
          return Object.assign({}, session, overrides);
        });
      });

    const getCapabilities: ProviderServiceShape["getCapabilities"] = (provider) =>
      registry.getByProvider(provider).pipe(Effect.map((adapter) => adapter.capabilities));

    const getPersistedResumeCursor = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const bindingOption = yield* directory.getBinding(threadId);
        const binding = Option.getOrUndefined(bindingOption);
        if (!binding) return undefined;
        return binding.resumeCursor ?? undefined;
      }).pipe(
        Effect.orElseSucceed(() => undefined),
      );

    const getSlashCommands: ProviderServiceShape["getSlashCommands"] = (threadId) =>
      Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId,
          operation: "ProviderService.getSlashCommands",
          allowRecovery: false,
        });
        if (routed.adapter.getSlashCommands === undefined) {
          return [];
        }
        return yield* routed.adapter.getSlashCommands(threadId);
      });

    const getCachedSlashCommands: ProviderServiceShape["getCachedSlashCommands"] = (providerKind) =>
      Effect.gen(function* () {
        const adapter = yield* registry.getByProvider(providerKind);
        if (adapter.getCachedSlashCommands === undefined) {
          return [];
        }
        return yield* adapter.getCachedSlashCommands();
      });

    const rollbackConversation: ProviderServiceShape["rollbackConversation"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.rollbackConversation",
          schema: ProviderRollbackConversationInput,
          payload: rawInput,
        });
        if (input.numTurns === 0) {
          return;
        }
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.rollbackConversation",
          allowRecovery: true,
        });
        yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
        yield* analytics.record("provider.conversation.rolled_back", {
          provider: routed.adapter.provider,
          turns: input.numTurns,
        });
      });

    const mcpGetStatus: ProviderServiceShape["mcpGetStatus"] = (threadId) =>
      Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId,
          operation: "ProviderService.mcpGetStatus",
          allowRecovery: false,
        });
        if (routed.adapter.mcpGetStatus === undefined) {
          return [];
        }
        return yield* routed.adapter.mcpGetStatus(threadId);
      });

    const mcpSetServers: ProviderServiceShape["mcpSetServers"] = (threadId, servers) =>
      Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId,
          operation: "ProviderService.mcpSetServers",
          allowRecovery: false,
        });
        if (routed.adapter.mcpSetServers === undefined) {
          return yield* toValidationError(
            "ProviderService.mcpSetServers",
            `Provider '${routed.adapter.provider}' does not support MCP server management.`,
          );
        }
        return yield* routed.adapter.mcpSetServers(threadId, servers);
      });

    const mcpReconnectServer: ProviderServiceShape["mcpReconnectServer"] = (threadId, serverName) =>
      Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId,
          operation: "ProviderService.mcpReconnectServer",
          allowRecovery: false,
        });
        if (routed.adapter.mcpReconnectServer === undefined) {
          return yield* toValidationError(
            "ProviderService.mcpReconnectServer",
            `Provider '${routed.adapter.provider}' does not support MCP server management.`,
          );
        }
        yield* routed.adapter.mcpReconnectServer(threadId, serverName);
      });

    const mcpToggleServer: ProviderServiceShape["mcpToggleServer"] = (
      threadId,
      serverName,
      enabled,
    ) =>
      Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId,
          operation: "ProviderService.mcpToggleServer",
          allowRecovery: false,
        });
        if (routed.adapter.mcpToggleServer === undefined) {
          return yield* toValidationError(
            "ProviderService.mcpToggleServer",
            `Provider '${routed.adapter.provider}' does not support MCP server management.`,
          );
        }
        yield* routed.adapter.mcpToggleServer(threadId, serverName, enabled);
      });

    const runStopAll = () =>
      Effect.gen(function* () {
        const threadIds = yield* directory.listThreadIds();
        yield* Effect.forEach(adapters, (adapter) => adapter.stopAll()).pipe(Effect.asVoid);
        yield* Effect.forEach(threadIds, (threadId) =>
          directory.getProvider(threadId).pipe(
            Effect.flatMap((provider) =>
              directory.upsert({
                threadId,
                provider,
                status: "stopped",
                runtimePayload: {
                  activeTurnId: null,
                  lastRuntimeEvent: "provider.stopAll",
                  lastRuntimeEventAt: new Date().toISOString(),
                },
              }),
            ),
          ),
        ).pipe(Effect.asVoid);
        yield* analytics.record("provider.sessions.stopped_all", {
          sessionCount: threadIds.length,
        });
        yield* analytics.flush;
      });

    yield* Effect.addFinalizer(() =>
      Effect.catch(runStopAll(), (cause) =>
        Effect.logWarning("failed to stop provider service", { cause }),
      ),
    );

    return {
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      getCapabilities,
      getPersistedResumeCursor,
      getSlashCommands,
      getCachedSlashCommands,
      rollbackConversation,
      mcpGetStatus,
      mcpSetServers,
      mcpReconnectServer,
      mcpToggleServer,
      stopAll: runStopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
      ...(mergedApprovalStream ? { streamApprovalEvents: mergedApprovalStream } : {}),
    } satisfies ProviderServiceShape;
  });

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService());

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService, makeProviderService(options));
}
