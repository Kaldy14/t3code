import { Schema } from "effect";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

// ── MCP Server Config Variants ────────────────────────────────────────

export const McpStdioServerConfig = Schema.Struct({
  type: Schema.optional(Schema.Literal("stdio")),
  command: TrimmedNonEmptyString,
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type McpStdioServerConfig = typeof McpStdioServerConfig.Type;

export const McpHttpServerConfig = Schema.Struct({
  type: Schema.Literal("http"),
  url: TrimmedNonEmptyString,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type McpHttpServerConfig = typeof McpHttpServerConfig.Type;

export const McpSseServerConfig = Schema.Struct({
  type: Schema.Literal("sse"),
  url: TrimmedNonEmptyString,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type McpSseServerConfig = typeof McpSseServerConfig.Type;

export const McpServerConfig = Schema.Union([
  McpStdioServerConfig,
  McpHttpServerConfig,
  McpSseServerConfig,
]);
export type McpServerConfig = typeof McpServerConfig.Type;

// ── MCP Server Status ─────────────────────────────────────────────────

export const McpServerConnectionStatus = Schema.Literals([
  "connected" as const,
  "failed" as const,
  "needs-auth" as const,
  "pending" as const,
  "disabled" as const,
]);
export type McpServerConnectionStatus = typeof McpServerConnectionStatus.Type;

export const McpServerToolInfo = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
});
export type McpServerToolInfo = typeof McpServerToolInfo.Type;

export const McpServerStatus = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: McpServerConnectionStatus,
  error: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Array(McpServerToolInfo)),
});
export type McpServerStatus = typeof McpServerStatus.Type;

export const McpSetServersResult = Schema.Struct({
  added: Schema.Array(Schema.String),
  removed: Schema.Array(Schema.String),
  errors: Schema.Record(Schema.String, Schema.String),
});
export type McpSetServersResult = typeof McpSetServersResult.Type;

// ── MCP RPC Input/Output Schemas ──────────────────────────────────────

export const McpGetStatusInput = Schema.Struct({
  threadId: ThreadId,
});
export type McpGetStatusInput = typeof McpGetStatusInput.Type;

export const McpGetStatusResult = Schema.Struct({
  servers: Schema.Array(McpServerStatus),
});
export type McpGetStatusResult = typeof McpGetStatusResult.Type;

export const McpSetServersInput = Schema.Struct({
  threadId: ThreadId,
  servers: Schema.Record(Schema.String, McpServerConfig),
});
export type McpSetServersInput = typeof McpSetServersInput.Type;

export const McpReconnectServerInput = Schema.Struct({
  threadId: ThreadId,
  serverName: TrimmedNonEmptyString,
});
export type McpReconnectServerInput = typeof McpReconnectServerInput.Type;

export const McpToggleServerInput = Schema.Struct({
  threadId: ThreadId,
  serverName: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type McpToggleServerInput = typeof McpToggleServerInput.Type;
