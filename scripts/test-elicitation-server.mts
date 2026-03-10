#!/usr/bin/env bun
/**
 * Zero-dependency MCP server that triggers elicitation for testing.
 * Implements the MCP JSON-RPC protocol over stdio directly.
 *
 * Usage:
 *   1. Add to your .mcp.json (project root) or ~/.claude/settings.json:
 *      {
 *        "mcpServers": {
 *          "test-elicitation": {
 *            "command": "bun",
 *            "args": ["<absolute-path>/scripts/test-elicitation-server.mts"]
 *          }
 *        }
 *      }
 *   2. Start a Claude Code session and prompt: "use the configure_api tool"
 *   3. The server will elicit user input with a form (API key + environment dropdown)
 */

const TOOLS = [
  {
    name: "configure_api",
    description: "Configure API settings — will ask user for credentials via elicitation",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why you need to configure the API" },
      },
    },
  },
  {
    name: "simple_question",
    description: "Ask a simple free-text question via elicitation (no schema)",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "What to ask about" },
      },
      required: ["topic"],
    },
  },
];

let nextRequestId = 1;
let clientSupportsElicitation = false;
const pendingRequests = new Map<number | string, (result: unknown) => void>();

function log(msg: string) {
  process.stderr.write(`[test-elicitation] ${msg}\n`);
}

function send(msg: Record<string, unknown>) {
  const json = JSON.stringify({ jsonrpc: "2.0", ...msg });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function sendResponse(id: number | string | null, result: unknown) {
  send({ id, result });
}

function sendRequest(method: string, params: unknown): Promise<unknown> {
  const id = nextRequestId++;
  return new Promise((resolve) => {
    pendingRequests.set(id, resolve);
    send({ id, method, params });
  });
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!clientSupportsElicitation) {
    log(`Client does not support elicitation, returning fallback for ${name}`);
    return {
      content: [
        {
          type: "text",
          text: `Cannot run ${name}: client does not support elicitation. Upgrade Claude Code or enable elicitation capability.`,
        },
      ],
      isError: true,
    };
  }

  if (name === "configure_api") {
    const result = (await sendRequest("elicitation/create", {
      message: "Please provide your API configuration:",
      requestedSchema: {
        type: "object",
        properties: {
          api_key: { type: "string", description: "Your API key" },
          environment: {
            type: "string",
            description: "Target environment",
            enum: ["development", "staging", "production"],
          },
          enable_logging: { type: "boolean", description: "Enable request logging?" },
        },
        required: ["api_key", "environment"],
      },
    })) as { action: string; content?: Record<string, unknown> };

    if (result.action === "accept" && result.content) {
      return {
        content: [
          { type: "text", text: `API configured!\n\n${JSON.stringify(result.content, null, 2)}` },
        ],
      };
    }
    return {
      content: [{ type: "text", text: `Elicitation ${result.action}. No config applied.` }],
    };
  }

  if (name === "simple_question") {
    const topic = (args.topic as string) ?? "anything";
    const result = (await sendRequest("elicitation/create", {
      message: `Please share your thoughts on: ${topic}`,
    })) as { action: string; content?: Record<string, unknown> };

    if (result.action === "accept" && result.content) {
      return {
        content: [{ type: "text", text: `User responded: ${JSON.stringify(result.content)}` }],
      };
    }
    return { content: [{ type: "text", text: `User ${result.action}d the question.` }] };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
}

function handleMessage(msg: {
  id?: number | string;
  method?: string;
  result?: unknown;
  params?: Record<string, unknown>;
}) {
  // Response to our outgoing request
  if (msg.id !== undefined && !msg.method && pendingRequests.has(msg.id)) {
    const resolve = pendingRequests.get(msg.id)!;
    pendingRequests.delete(msg.id);
    resolve(msg.result);
    return;
  }

  // Incoming request from client
  if (!msg.method) return;
  const id = msg.id ?? null;

  switch (msg.method) {
    case "initialize": {
      const clientVersion = (msg.params?.protocolVersion as string) ?? "2024-11-05";
      clientSupportsElicitation = !!msg.params?.capabilities?.elicitation;
      log(`Client version: ${clientVersion}, elicitation: ${clientSupportsElicitation}`);
      sendResponse(id, {
        protocolVersion: clientVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "test-elicitation", version: "1.0.0" },
      });
      break;
    }
    case "notifications/initialized":
      break;
    case "tools/list":
      sendResponse(id, { tools: TOOLS });
      break;
    case "tools/call": {
      const params = msg.params ?? {};
      const name = params.name as string;
      const args = (params.arguments as Record<string, unknown>) ?? {};
      handleToolCall(name, args).then((result) => sendResponse(id!, result));
      break;
    }
    default:
      if (id !== null) {
        send({ id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      }
  }
}

// Parse JSON-RPC messages from stdin (Content-Length framing)
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const len = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + len) break;
    const body = buffer.slice(bodyStart, bodyStart + len);
    buffer = buffer.slice(bodyStart + len);
    try {
      handleMessage(JSON.parse(body));
    } catch (e) {
      log(`Parse/handle error: ${e}`);
    }
  }
});

log("server started");
