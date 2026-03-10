# AGENTS.md

## Task Completion Requirements

- Both `bun lint` and `bun typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Project Snapshot

T3 Code is a minimal web GUI for using code agents (Claude Code, Codex, Cursor).

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there are shared logic that can be extracted to a separate module. Duplicate logic across mulitple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Tech Stack

- **Runtime/Package Manager**: Bun
- **Monorepo**: Turbo
- **Backend**: Node.js + Effect (functional effects runtime) + WebSocket (`ws`)
- **Frontend**: React 19 + Vite + TanStack (Router, Query, Virtual) + Zustand + Tailwind CSS v4
- **Contracts**: Effect Schema (runtime-validated types shared between server and web)
- **Database**: SQLite via `@effect/sql-sqlite-bun`
- **Testing**: Vitest + MSW (mocking) + Playwright (browser)
- **Linting/Formatting**: oxlint + oxfmt

## Package Roles

- `apps/server`: Node.js WebSocket server. Manages provider sessions, serves the React web app, and streams events to the browser.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared Effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Provider Architecture

T3 Code supports multiple AI code agent providers via a unified adapter pattern. The current priority is **Claude Code**.

### ProviderKind

Three providers are defined in contracts: `"claudeCode"` | `"codex"` | `"cursor"`. The default provider in the UI is `"claudeCode"`.

### Adapter Pattern

Each provider implements `ProviderAdapterShape` (start/stop session, send turn, interrupt, approvals, events). Adapters are registered in `ProviderAdapterRegistry` and resolved by `ProviderService` at runtime.

Key services (all Effect-based):

- `ProviderService` — cross-provider facade used by WebSocket transport
- `ProviderAdapterRegistry` — maps ProviderKind → adapter
- `ProviderSessionDirectory` — persists session bindings to SQLite

### Event Flow

1. Web app sends commands via WebSocket RPC (`orchestration.dispatchCommand`)
2. Server routes to the correct adapter via `ProviderService`
3. Adapter streams `ProviderRuntimeEvent` objects
4. Events are projected into orchestration domain events and pushed to the client on `orchestration.domainEvent`

## Claude Code Provider

SDK: `@anthropic-ai/claude-agent-sdk` (async iterable query sessions).

### Key Files

- `apps/server/src/provider/Layers/ClaudeCodeAdapter.ts` — main adapter (~1900 lines). Manages session state, turn processing, tool approval routing, resume capability.
- `apps/server/src/provider/Services/ClaudeCodeAdapter.ts` — Effect service tag definition.
- `packages/contracts/src/provider.ts` — `ClaudeCodeProviderStartOptions` (binaryPath, permissionMode, maxThinkingTokens).

### Session Lifecycle

1. `startSession` — initializes SDK query with model, permission mode, working directory
2. Messages queued via internal `promptQueue`
3. SDK streams responses as async iterables → mapped to `ProviderRuntimeEvent`
4. Tool calls classified by name (bash → command, edit/write → file-change, mcp → mcp_tool_call)
5. Approvals surfaced to UI via `PendingApprovalsPanel` in ChatView
6. Resume supported via stored `ClaudeResumeState` (threadId, resume UUID, turnCount)

### Important Details

- `ProviderSession.threadId` is **optional** — Claude sessions get threadId assigned by the SDK after first turn
- Claude adapter uses `internalThreadId` to key sessions in its in-memory Map, separate from the provider-facing threadId
- Supports in-session model switching (capability: `sessionModelSwitch: "in-session"`)
- `stopAll` method on `ProviderServiceShape` stops all active sessions across all adapters

## Codex App Server

The Codex adapter starts `codex app-server` (JSON-RPC over stdio) per session, then streams structured events to the browser.

- Session startup/resume: `apps/server/src/codexAppServerManager.ts`
- Provider dispatch: `apps/server/src/providerManager.ts`
- Docs: https://developers.openai.com/codex/sdk/#app-server

## WebSocket Protocol

### RPC Methods (client → server)

- `orchestration.*` — getSnapshot, dispatchCommand, getTurnDiff, getFullThreadDiff, replayEvents
- `projects.*` — list, add, remove, searchEntries, writeFile
- `git.*` — pull, status, listBranches, createBranch, checkout, etc.
- `terminal.*` — open, write, resize, clear, restart, close
- `server.*` — getConfig, upsertKeybinding

### Push Channels (server → client)

- `orchestration.domainEvent` — provider runtime activity
- `terminal.event` — terminal I/O
- `server.welcome` — initial connection payload
- `server.configUpdated` — config changes

## Development

```bash
bun dev              # Server + web together
bun dev:server       # Server only
bun dev:web          # Web only (port 5733)
bun build            # Build all
bun typecheck        # Type-check all packages
bun lint             # oxlint
bun run test         # Vitest (NEVER use `bun test`)
bun fmt              # oxfmt
```

### Key Environment Variables

- `T3CODE_PORT` — server port (default 3000)
- `T3CODE_MODE` — "web" or "desktop"
- `T3CODE_STATE_DIR` — state persistence directory
- `VITE_WS_URL` — WebSocket URL for web dev mode

## Reference Repos

- Codex: https://github.com/openai/codex
- CodexMonitor (Tauri reference): https://github.com/Dimillian/CodexMonitor
