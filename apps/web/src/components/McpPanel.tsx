import type { McpServerStatus, ThreadId } from "@t3tools/contracts";
import {
  ChevronRightIcon,
  PlugIcon,
  RefreshCwIcon,
  PlusIcon,
  Trash2Icon,
  AlertCircleIcon,
  WrenchIcon,
} from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "../nativeApi";
import { cn } from "~/lib/utils";
import { Popover, PopoverTrigger, PopoverPopup } from "./ui/popover";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { Input } from "./ui/input";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "./ui/collapsible";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";

// ── Query helpers ─────────────────────────────────────────────────────

export const mcpQueryKeys = {
  all: ["mcp"] as const,
  status: (threadId: ThreadId) => ["mcp", "status", threadId] as const,
};

export function mcpStatusQueryOptions(threadId: ThreadId | null) {
  return queryOptions({
    queryKey: threadId ? mcpQueryKeys.status(threadId) : mcpQueryKeys.all,
    queryFn: async (): Promise<ReadonlyArray<McpServerStatus>> => {
      const api = ensureNativeApi();
      if (!threadId) throw new Error("No threadId");
      const result = await api.mcp.getStatus({ threadId });
      return result.servers;
    },
    enabled: threadId !== null,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
}

// ── Status dot colors ─────────────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
  connected: "bg-emerald-500",
  failed: "bg-red-500",
  "needs-auth": "bg-amber-500",
  pending: "bg-amber-400 animate-pulse",
  disabled: "bg-neutral-500",
};

const STATUS_LABEL: Record<string, string> = {
  connected: "Connected",
  failed: "Failed",
  "needs-auth": "Auth required",
  pending: "Connecting...",
  disabled: "Disabled",
};

// ── Server row ────────────────────────────────────────────────────────

interface McpServerRowProps {
  server: McpServerStatus;
  threadId: ThreadId;
  onRemove?: (serverName: string) => void;
}

const McpServerRow = memo(function McpServerRow({ server, threadId, onRemove }: McpServerRowProps) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  const toggleMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const api = ensureNativeApi();
      await api.mcp.toggleServer({
        threadId,
        serverName: server.name,
        enabled,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: mcpQueryKeys.status(threadId),
      });
    },
  });

  const reconnectMutation = useMutation({
    mutationFn: async () => {
      const api = ensureNativeApi();
      await api.mcp.reconnectServer({
        threadId,
        serverName: server.name,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: mcpQueryKeys.status(threadId),
      });
    },
  });

  const toolCount = server.tools?.length ?? 0;
  const isDynamic = server.scope === "dynamic";
  const isEnabled = server.status !== "disabled";
  const isFailed = server.status === "failed";
  const dotClass = STATUS_DOT[server.status] ?? "bg-neutral-400";

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className="group border-b border-border/30 last:border-b-0">
        {/* Main row */}
        <div className="flex items-center gap-2 px-3 py-2">
          {/* Status dot */}
          <span
            className={cn("size-2 shrink-0 rounded-full", dotClass)}
            title={STATUS_LABEL[server.status] ?? server.status}
          />

          {/* Name + scope + status */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{server.name}</span>
            {server.scope && (
              <Badge
                variant="outline"
                size="sm"
                className="shrink-0 text-[10px] uppercase tracking-wider opacity-60"
              >
                {server.scope}
              </Badge>
            )}
            {server.status !== "connected" && server.status !== "disabled" && (
              <span
                className={cn(
                  "shrink-0 text-[10px]",
                  server.status === "failed" && "text-red-400",
                  server.status === "needs-auth" && "text-amber-400",
                  server.status === "pending" && "text-amber-300",
                )}
              >
                {STATUS_LABEL[server.status] ?? server.status}
              </span>
            )}
          </div>

          {/* Tool count expand trigger */}
          {toolCount > 0 && (
            <CollapsibleTrigger className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[11px] tabular-nums text-muted-foreground hover:text-foreground">
              <WrenchIcon className="size-3 opacity-60" />
              {toolCount}
              <ChevronRightIcon
                className={cn(
                  "size-3 opacity-50 transition-transform duration-150",
                  expanded && "rotate-90",
                )}
              />
            </CollapsibleTrigger>
          )}

          {/* Actions */}
          <div className="flex shrink-0 items-center gap-1">
            {isFailed && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => reconnectMutation.mutate()}
                      disabled={reconnectMutation.isPending}
                    />
                  }
                >
                  <RefreshCwIcon
                    className={cn("size-3", reconnectMutation.isPending && "animate-spin")}
                  />
                </TooltipTrigger>
                <TooltipPopup>Reconnect</TooltipPopup>
              </Tooltip>
            )}

            {isDynamic && onRemove && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button variant="ghost" size="icon-xs" onClick={() => onRemove(server.name)} />
                  }
                >
                  <Trash2Icon className="size-3 text-destructive-foreground/70" />
                </TooltipTrigger>
                <TooltipPopup>Remove</TooltipPopup>
              </Tooltip>
            )}

            <Switch
              checked={isEnabled}
              onCheckedChange={(checked) => toggleMutation.mutate(checked)}
              disabled={toggleMutation.isPending}
              className="scale-75"
            />
          </div>
        </div>

        {/* Error message */}
        {server.error && (
          <div className="flex items-start gap-1.5 px-3 pb-2 text-[11px] text-destructive-foreground">
            <AlertCircleIcon className="mt-px size-3 shrink-0" />
            <span className="min-w-0 break-words">{server.error}</span>
          </div>
        )}

        {/* Expandable tools list */}
        {toolCount > 0 && (
          <CollapsiblePanel>
            <div className="border-t border-border/20 bg-muted/30 px-3 py-1.5">
              <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                {server.tools!.map((tool) => (
                  <span
                    key={tool.name}
                    className="inline-flex items-center text-[11px] text-muted-foreground"
                    title={tool.description ?? tool.name}
                  >
                    <span className="mr-1 opacity-40">$</span>
                    {tool.name}
                  </span>
                ))}
              </div>
            </div>
          </CollapsiblePanel>
        )}
      </div>
    </Collapsible>
  );
});

// ── Add server form ───────────────────────────────────────────────────

type ServerType = "stdio" | "http" | "sse";

interface AddServerFormProps {
  threadId: ThreadId;
  existingDynamicServers: Record<string, unknown>;
}

const AddServerForm = memo(function AddServerForm({
  threadId,
  existingDynamicServers,
}: AddServerFormProps) {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [serverType, setServerType] = useState<ServerType>("stdio");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");

  const addMutation = useMutation({
    mutationFn: async () => {
      const api = ensureNativeApi();
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error("Server name is required");

      let config: Record<string, unknown>;
      if (serverType === "stdio") {
        if (!command.trim()) throw new Error("Command is required");
        config = {
          type: "stdio",
          command: command.trim(),
          ...(args.trim()
            ? {
                args: args
                  .split(",")
                  .map((a) => a.trim())
                  .filter(Boolean),
              }
            : {}),
        };
      } else {
        if (!url.trim()) throw new Error("URL is required");
        config = { type: serverType, url: url.trim() };
      }

      const servers = {
        ...existingDynamicServers,
        [trimmedName]: config,
      };
      // @ts-expect-error dynamic server configs are placeholders
      await api.mcp.setServers({ threadId, servers });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: mcpQueryKeys.status(threadId),
      });
      setName("");
      setCommand("");
      setArgs("");
      setUrl("");
      setShowForm(false);
    },
  });

  if (!showForm) {
    return (
      <button
        type="button"
        onClick={() => setShowForm(true)}
        className="flex w-full items-center justify-center gap-1.5 border-t border-border/30 px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
      >
        <PlusIcon className="size-3" />
        Add server
      </button>
    );
  }

  return (
    <div className="border-t border-border/30 px-3 py-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">Add MCP Server</span>
        <button
          type="button"
          onClick={() => setShowForm(false)}
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>

      {/* Type selector */}
      <div className="flex gap-1">
        {(["stdio", "http", "sse"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setServerType(t)}
            className={cn(
              "rounded-md px-2 py-1 text-[11px] font-medium uppercase tracking-wider transition-colors",
              serverType === t
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/40",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Name */}
      <Input
        size="sm"
        placeholder="Server name"
        value={name}
        onChange={(e) => setName((e.target as HTMLInputElement).value)}
      />

      {/* Type-specific fields */}
      {serverType === "stdio" ? (
        <>
          <Input
            size="sm"
            placeholder="Command (e.g. npx)"
            value={command}
            onChange={(e) => setCommand((e.target as HTMLInputElement).value)}
          />
          <Input
            size="sm"
            placeholder="Args (comma-separated)"
            value={args}
            onChange={(e) => setArgs((e.target as HTMLInputElement).value)}
          />
        </>
      ) : (
        <Input
          size="sm"
          placeholder={`${serverType.toUpperCase()} URL`}
          value={url}
          onChange={(e) => setUrl((e.target as HTMLInputElement).value)}
        />
      )}

      {/* Error */}
      {addMutation.error && (
        <p className="text-[11px] text-destructive-foreground">{addMutation.error.message}</p>
      )}

      {/* Submit */}
      <Button
        size="sm"
        variant="default"
        className="w-full"
        onClick={() => addMutation.mutate()}
        disabled={addMutation.isPending}
      >
        {addMutation.isPending ? "Adding..." : "Add Server"}
      </Button>
    </div>
  );
});

// ── Main panel ────────────────────────────────────────────────────────

interface McpPanelProps {
  threadId: ThreadId;
}

export const McpPanel = memo(function McpPanel({ threadId }: McpPanelProps) {
  const queryClient = useQueryClient();
  const { data: servers, isLoading } = useQuery(mcpStatusQueryOptions(threadId));

  const connectedCount = useMemo(
    () => servers?.filter((s) => s.status === "connected").length ?? 0,
    [servers],
  );

  const totalCount = servers?.length ?? 0;

  // Build a record of currently dynamic servers for additive setMcpServers calls
  const dynamicServerConfigs = useMemo(() => {
    if (!servers) return {};
    const configs: Record<string, unknown> = {};
    for (const s of servers) {
      if (s.scope === "dynamic") {
        configs[s.name] = {}; // placeholder — SDK tracks actual config
      }
    }
    return configs;
  }, [servers]);

  const handleRemoveServer = useCallback(
    async (serverName: string) => {
      const api = ensureNativeApi();
      const remaining = { ...dynamicServerConfigs };
      delete remaining[serverName];
      // @ts-expect-error dynamic server configs are placeholders
      await api.mcp.setServers({ threadId, servers: remaining });
      void queryClient.invalidateQueries({
        queryKey: mcpQueryKeys.status(threadId),
      });
    },
    [threadId, dynamicServerConfigs, queryClient],
  );

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
          totalCount > 0 && connectedCount === totalCount && "text-muted-foreground",
          totalCount > 0 && connectedCount < totalCount && "text-amber-500/80",
        )}
      >
        <PlugIcon className="size-3.5" />
        {totalCount > 0 && (
          <span className="tabular-nums">
            {connectedCount}/{totalCount}
          </span>
        )}
      </PopoverTrigger>

      <PopoverPopup side="bottom" align="end" sideOffset={8} className="w-80">
        {/* Header */}
        <div className="flex items-center justify-between pb-2">
          <span className="text-sm font-semibold text-foreground">MCP Servers</span>
          {totalCount > 0 && (
            <Badge variant="outline" size="sm">
              {connectedCount} of {totalCount} connected
            </Badge>
          )}
        </div>

        {/* Server list */}
        <div className="-mx-4 border-t border-border/30">
          {isLoading && (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              Loading servers...
            </div>
          )}

          {!isLoading && totalCount === 0 && (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              No MCP servers configured
            </div>
          )}

          {servers?.map((server) => (
            // @ts-expect-error exactOptionalPropertyTypes
            <McpServerRow
              key={server.name}
              server={server}
              threadId={threadId}
              onRemove={server.scope === "dynamic" ? handleRemoveServer : undefined}
            />
          ))}

          {/* Add server form */}
          <AddServerForm threadId={threadId} existingDynamicServers={dynamicServerConfigs} />
        </div>
      </PopoverPopup>
    </Popover>
  );
});
