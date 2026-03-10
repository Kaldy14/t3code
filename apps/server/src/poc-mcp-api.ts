/**
 * POC: MCP Server Management via Claude Agent SDK
 *
 * Validates that the SDK MCP APIs work as expected before building the full feature.
 *
 * Run: env -u CLAUDECODE bun run apps/server/src/poc-mcp-api.ts
 */
import {
  query,
  type McpServerStatus,
  type McpSetServersResult,
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, writeFileSync } from "fs";

const LOG = "/tmp/poc-mcp.log";
function log(msg: string) {
  appendFileSync(LOG, msg + "\n");
  console.log(msg);
}

function logObj(label: string, data: unknown) {
  const s = `\n=== ${label} ===\n${JSON.stringify(data, null, 2)}`;
  log(s);
}

async function main() {
  writeFileSync(LOG, "");
  log("POC: MCP Server Management via Claude Agent SDK\n");

  // Strip CLAUDECODE to avoid nested session detection
  const env = { ...process.env };
  delete env.CLAUDECODE;

  // Use a simple string prompt — the SDK handles it natively
  log("Starting SDK session with string prompt...");
  const session = query({
    prompt: "Say hello in exactly 3 words.",
    options: {
      cwd: process.cwd(),
      model: "claude-haiku-4-5",
      permissionMode: "plan",
      env: env as Record<string, string>,
      stderr: (data: string) => log(`[stderr] ${data}`),
    },
  });

  // Consume stream until init, then test MCP APIs
  let initReceived = false;
  try {
    for await (const msg of session) {
      const subtype = "subtype" in msg ? (msg as any).subtype : "";
      log(`[stream] type=${msg.type} subtype=${subtype}`);

      if (msg.type === "system" && subtype === "init") {
        initReceived = true;
        const initMsg = msg as any;
        logObj("INIT — mcp_servers", initMsg.mcp_servers);
        logObj("INIT — session_id", initMsg.session_id);
        log(`INIT — tools count: ${initMsg.tools?.length ?? 0}`);

        // -----------------------------------------------------------------
        // Test 1: mcpServerStatus()
        // -----------------------------------------------------------------
        log("\n--- Test 1: mcpServerStatus() ---");
        try {
          const statuses: McpServerStatus[] = await session.mcpServerStatus();
          logObj("mcpServerStatus() result", statuses);
          for (const s of statuses) {
            log(
              `  ${s.name}: status=${s.status}, scope=${s.scope ?? "?"}, tools=${s.tools?.length ?? 0}`,
            );
            if (s.tools) {
              for (const t of s.tools.slice(0, 3)) {
                log(`    - ${t.name}: ${t.description?.slice(0, 60) ?? ""}`);
              }
              if (s.tools.length > 3) log(`    ... +${s.tools.length - 3} more`);
            }
            if (s.error) log(`    error: ${s.error}`);
          }
        } catch (err) {
          log(`  FAILED: ${err instanceof Error ? err.message : err}`);
        }

        // -----------------------------------------------------------------
        // Test 2: setMcpServers() — add a fake server
        // -----------------------------------------------------------------
        log("\n--- Test 2: setMcpServers() — add poc-test ---");
        try {
          const servers: Record<string, McpServerConfig> = {
            "poc-test-server": {
              command: "echo",
              args: ["hello"],
            } as McpServerConfig,
          };
          const result: McpSetServersResult = await session.setMcpServers(servers);
          logObj("setMcpServers() result", result);
        } catch (err) {
          log(`  FAILED: ${err instanceof Error ? err.message : err}`);
        }

        // Check status after add
        try {
          const statuses = await session.mcpServerStatus();
          const poc = statuses.find((s) => s.name === "poc-test-server");
          logObj("poc-test-server after add", poc ?? "NOT FOUND");
          log(`  All servers: ${statuses.map((s) => `${s.name}(${s.status})`).join(", ")}`);
        } catch (err) {
          log(`  status check FAILED: ${err instanceof Error ? err.message : err}`);
        }

        // -----------------------------------------------------------------
        // Test 3: toggleMcpServer() — disable
        // -----------------------------------------------------------------
        log("\n--- Test 3: toggleMcpServer(false) ---");
        try {
          await session.toggleMcpServer("poc-test-server", false);
          log("  toggleMcpServer(false) succeeded");
          const statuses = await session.mcpServerStatus();
          const poc = statuses.find((s) => s.name === "poc-test-server");
          log(`  poc-test-server status after disable: ${poc?.status ?? "NOT FOUND"}`);
        } catch (err) {
          log(`  FAILED: ${err instanceof Error ? err.message : err}`);
        }

        // -----------------------------------------------------------------
        // Test 4: reconnectMcpServer()
        // -----------------------------------------------------------------
        log("\n--- Test 4: reconnectMcpServer() ---");
        try {
          await session.toggleMcpServer("poc-test-server", true);
          await session.reconnectMcpServer("poc-test-server");
          log("  reconnectMcpServer succeeded");
          const statuses = await session.mcpServerStatus();
          const poc = statuses.find((s) => s.name === "poc-test-server");
          log(`  poc-test-server status after reconnect: ${poc?.status ?? "NOT FOUND"}`);
        } catch (err) {
          log(`  FAILED: ${err instanceof Error ? err.message : err}`);
        }

        // -----------------------------------------------------------------
        // Test 5: setMcpServers({}) — remove all dynamic
        // -----------------------------------------------------------------
        log("\n--- Test 5: setMcpServers({}) — remove all dynamic ---");
        try {
          const result = await session.setMcpServers({});
          logObj("setMcpServers({}) result", result);
          const statuses = await session.mcpServerStatus();
          const poc = statuses.find((s) => s.name === "poc-test-server");
          log(`  poc-test-server after removal: ${poc ? poc.status : "REMOVED (expected)"}`);
          log(`  Remaining: ${statuses.map((s) => `${s.name}(${s.status})`).join(", ") || "none"}`);
        } catch (err) {
          log(`  FAILED: ${err instanceof Error ? err.message : err}`);
        }

        // -----------------------------------------------------------------
        // Summary
        // -----------------------------------------------------------------
        log("\n" + "=".repeat(60));
        log("POC COMPLETE — All MCP API calls tested");
        log("=".repeat(60));

        session.close();
        process.exit(0);
      }

      // Safety: don't consume forever
      if (msg.type === "result") {
        log("Got result before init — unexpected");
        break;
      }
    }
  } catch (err) {
    log(`Stream error: ${err instanceof Error ? err.message : err}`);
    if (err instanceof Error) log(`Stack: ${err.stack}`);
  }

  if (!initReceived) {
    log("ERROR: Never received init message");
  }
  session.close();
  process.exit(initReceived ? 0 : 1);
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
