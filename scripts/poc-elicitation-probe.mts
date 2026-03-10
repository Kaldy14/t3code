#!/usr/bin/env bun
/**
 * POC: Claude Agent SDK Elicitation Probe
 *
 * This script connects to the Claude Agent SDK and registers an `onElicitation`
 * callback to capture the raw shape of MCP elicitation requests. It also logs
 * all system messages with subtype 'elicitation_complete' to understand the
 * full lifecycle.
 *
 * Usage:
 *   bun scripts/poc-elicitation-probe.mts [--cwd /path/to/project]
 *
 * To trigger an elicitation:
 *   1. Have an MCP server configured that uses elicitation (e.g., one that
 *      requests user input via requestedSchema)
 *   2. Send a prompt that causes the MCP tool to fire
 *   3. The script will log the full ElicitationRequest shape
 *
 * Alternatively, send the prompt "test elicitation" and the script will
 * auto-accept with dummy data so you can observe the message flow.
 */

import { query, type SDKMessage, type ElicitationRequest } from "@anthropic-ai/claude-agent-sdk";

const CWD = process.argv.includes("--cwd")
  ? process.argv[process.argv.indexOf("--cwd") + 1]!
  : process.cwd();

const LOG_PREFIX = {
  elicitation: "\x1b[35m[ELICITATION]\x1b[0m",
  system: "\x1b[36m[SYSTEM]\x1b[0m",
  stream: "\x1b[33m[STREAM]\x1b[0m",
  assistant: "\x1b[32m[ASSISTANT]\x1b[0m",
  info: "\x1b[34m[INFO]\x1b[0m",
};

function logJson(prefix: string, label: string, data: unknown) {
  console.log(`\n${prefix} === ${label} ===`);
  console.log(JSON.stringify(data, null, 2));
  console.log(`${prefix} === END ${label} ===\n`);
}

// Track elicitation requests for analysis
const elicitationLog: Array<{
  timestamp: string;
  type: "request" | "complete";
  data: unknown;
}> = [];

/**
 * onElicitation callback — the core of what we're probing.
 *
 * In a real implementation this would:
 *   1. Map the ElicitationRequest to a `user-input.requested` provider event
 *   2. Create a Deferred to block until the UI responds
 *   3. Return the ElicitationResult with the user's answers
 *
 * For this POC, we log everything and auto-accept with empty content.
 */
async function handleElicitation(
  request: ElicitationRequest,
  options: { signal: AbortSignal },
): Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }> {
  const entry = {
    timestamp: new Date().toISOString(),
    type: "request" as const,
    data: {
      serverName: request.serverName,
      message: request.message,
      mode: request.mode,
      url: request.url,
      elicitationId: request.elicitationId,
      requestedSchema: request.requestedSchema,
      // Log the full raw object in case there are undocumented fields
      _raw: request,
    },
  };
  elicitationLog.push(entry);

  logJson(LOG_PREFIX.elicitation, "ELICITATION REQUEST RECEIVED", entry.data);

  // Log the JSON Schema if present (form mode)
  if (request.requestedSchema) {
    logJson(
      LOG_PREFIX.elicitation,
      "REQUESTED SCHEMA (JSON Schema for form fields)",
      request.requestedSchema,
    );

    // Attempt to derive field names from the schema
    const properties = (request.requestedSchema as Record<string, unknown>).properties;
    if (properties && typeof properties === "object") {
      console.log(`${LOG_PREFIX.elicitation} Schema properties:`);
      for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
        const prop = value as Record<string, unknown>;
        console.log(
          `  - ${key}: type=${prop.type ?? "unknown"}, description=${prop.description ?? "none"}`,
        );
      }
    }
  }

  // Log abort signal state
  console.log(`${LOG_PREFIX.elicitation} AbortSignal aborted: ${options.signal.aborted}`);

  // For POC: auto-accept with empty content
  // In real implementation, this would await a Deferred resolved by the UI
  const result = {
    action: "accept" as const,
    content: {} as Record<string, unknown>,
  };

  console.log(`${LOG_PREFIX.elicitation} Returning auto-accept response:`, JSON.stringify(result));
  return result;
}

/**
 * Process SDK messages, focusing on elicitation-related system messages
 */
function handleMessage(message: SDKMessage) {
  // Log ALL system messages to catch elicitation lifecycle events
  if (message.type === "system") {
    const sysMsg = message as Record<string, unknown>;
    const subtype = sysMsg.subtype as string;

    if (subtype === "elicitation_complete") {
      const entry = {
        timestamp: new Date().toISOString(),
        type: "complete" as const,
        data: {
          subtype,
          mcp_server_name: sysMsg.mcp_server_name,
          elicitation_id: sysMsg.elicitation_id,
          _raw: message,
        },
      };
      elicitationLog.push(entry);
      logJson(LOG_PREFIX.system, "ELICITATION COMPLETE MESSAGE", entry.data);
    } else if (subtype === "init") {
      console.log(`${LOG_PREFIX.system} Session initialized (subtype: init)`);
    } else if (subtype === "status") {
      console.log(
        `${LOG_PREFIX.system} Status: ${(sysMsg as Record<string, unknown>).status ?? "unknown"}`,
      );
    } else {
      console.log(`${LOG_PREFIX.system} System message subtype: ${subtype}`);
    }
    return;
  }

  // Log assistant text (truncated)
  if (message.type === "assistant") {
    const content = (message as Record<string, unknown>).message as Record<string, unknown>;
    const blocks = content?.content as Array<Record<string, unknown>>;
    if (blocks) {
      for (const block of blocks) {
        if (block.type === "text") {
          const text = (block.text as string).slice(0, 200);
          console.log(`${LOG_PREFIX.assistant} ${text}${text.length >= 200 ? "..." : ""}`);
        }
      }
    }
    return;
  }

  // Log result messages
  if (message.type === "result") {
    const result = message as Record<string, unknown>;
    console.log(
      `${LOG_PREFIX.info} Turn result: ${result.is_error ? "ERROR" : "OK"} | reason: ${result.reason ?? "none"}`,
    );
    return;
  }

  // Log stream events briefly
  if (message.type === "stream_event") {
    const event = (message as Record<string, unknown>).event as Record<string, unknown>;
    if (event?.type === "content_block_delta") {
      // Skip content deltas (too verbose)
      return;
    }
    console.log(`${LOG_PREFIX.stream} ${event?.type ?? message.type}`);
  }
}

async function main() {
  console.log(`${LOG_PREFIX.info} Starting elicitation probe...`);
  console.log(`${LOG_PREFIX.info} CWD: ${CWD}`);
  console.log(
    `${LOG_PREFIX.info} Waiting for SDK messages. Send a prompt that triggers an MCP elicitation.`,
  );
  console.log(`${LOG_PREFIX.info} Press Ctrl+C to stop and see the elicitation log summary.\n`);

  // Create a simple prompt iterator that reads from stdin
  const prompts = createStdinPromptIterator();

  const session = query({
    prompt: prompts,
    options: {
      cwd: CWD,
      includePartialMessages: false,
      onElicitation: handleElicitation,
      // Use default permission mode so we can see the full flow
    },
  });

  // Register cleanup
  process.on("SIGINT", () => {
    console.log(`\n${LOG_PREFIX.info} === ELICITATION LOG SUMMARY ===`);
    if (elicitationLog.length === 0) {
      console.log(`${LOG_PREFIX.info} No elicitation events captured.`);
    } else {
      logJson(LOG_PREFIX.info, "ALL CAPTURED ELICITATION EVENTS", elicitationLog);
    }
    process.exit(0);
  });

  // Consume the message stream
  for await (const message of session) {
    handleMessage(message);
  }

  console.log(`\n${LOG_PREFIX.info} Session ended.`);
  console.log(`${LOG_PREFIX.info} Total elicitation events: ${elicitationLog.length}`);
  if (elicitationLog.length > 0) {
    logJson(LOG_PREFIX.info, "ALL CAPTURED ELICITATION EVENTS", elicitationLog);
  }
}

/**
 * Creates an async iterator that reads prompts from stdin.
 */
async function* createStdinPromptIterator(): AsyncIterableIterator<string> {
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  while (true) {
    const line = await new Promise<string | null>((resolve) => {
      rl.question("\n> ", (answer) => resolve(answer));
      rl.once("close", () => resolve(null));
    });

    if (line === null) break;
    if (line.trim() === "") continue;
    if (line.trim() === "/quit" || line.trim() === "/exit") break;

    yield line;
  }

  rl.close();
}

main().catch((err) => {
  console.error(`${LOG_PREFIX.info} Fatal error:`, err);
  process.exit(1);
});
