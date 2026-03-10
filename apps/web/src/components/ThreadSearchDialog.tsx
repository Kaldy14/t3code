import {
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { GitBranchIcon, SearchIcon } from "lucide-react";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { useStore } from "../store";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import { formatRelativeTime, threadStatusPill } from "../lib/threadStatus";
import type { Thread, Project } from "../types";
import { CommandDialog, CommandDialogPopup } from "./ui/command";

const MAX_RESULTS = 50;
const RECENT_LIMIT = 20;

// ── Highlight matching text ──────────────────────────────────────────

function highlightMatch(text: string, query: string): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-yellow-200/40 text-inherit dark:bg-yellow-400/20">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

// ── Search logic ─────────────────────────────────────────────────────

interface SearchResult {
  thread: Thread;
  matchField: "title" | "branch" | "project" | "message" | null;
  matchSnippet: string | null;
}

function searchThreads(
  threads: readonly Thread[],
  projects: readonly Project[],
  query: string,
): SearchResult[] {
  if (!query.trim()) {
    const sorted = [...threads].toSorted(
      (a, b) =>
        Math.max(new Date(b.updatedAt).getTime(), new Date(b.createdAt).getTime()) -
        Math.max(new Date(a.updatedAt).getTime(), new Date(a.createdAt).getTime()),
    );
    return sorted.slice(0, RECENT_LIMIT).map((thread) => ({
      thread,
      matchField: null,
      matchSnippet: null,
    }));
  }

  const q = query.toLowerCase();
  const projectNameById = new Map<ProjectId, string>(projects.map((p) => [p.id, p.name]));
  const results: SearchResult[] = [];

  for (const thread of threads) {
    if (results.length >= MAX_RESULTS) break;

    if (thread.title.toLowerCase().includes(q)) {
      results.push({ thread, matchField: "title", matchSnippet: null });
      continue;
    }

    if (thread.branch?.toLowerCase().includes(q)) {
      results.push({ thread, matchField: "branch", matchSnippet: null });
      continue;
    }

    const projectName = projectNameById.get(thread.projectId);
    if (projectName?.toLowerCase().includes(q)) {
      results.push({ thread, matchField: "project", matchSnippet: null });
      continue;
    }

    const firstUserMessage = thread.messages.find((m) => m.role === "user");
    if (firstUserMessage?.text.toLowerCase().includes(q)) {
      const lowerText = firstUserMessage.text.toLowerCase();
      const matchIdx = lowerText.indexOf(q);
      const start = Math.max(0, matchIdx - 30);
      const end = Math.min(firstUserMessage.text.length, matchIdx + q.length + 60);
      const snippet =
        (start > 0 ? "..." : "") +
        firstUserMessage.text.slice(start, end).trim() +
        (end < firstUserMessage.text.length ? "..." : "");
      results.push({ thread, matchField: "message", matchSnippet: snippet });
      continue;
    }
  }

  return results;
}

// ── Flatten grouped results for keyboard navigation ──────────────────

interface GroupedResults {
  project: Project;
  results: SearchResult[];
}

function groupByProject(results: SearchResult[], projects: readonly Project[]): GroupedResults[] {
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const groups = new Map<ProjectId, GroupedResults>();

  for (const result of results) {
    const project = projectById.get(result.thread.projectId);
    if (!project) continue;
    const existing = groups.get(project.id);
    if (existing) {
      existing.results.push(result);
    } else {
      groups.set(project.id, { project, results: [result] });
    }
  }

  return [...groups.values()];
}

// ── Result item ──────────────────────────────────────────────────────

function ThreadSearchResultRow({
  result,
  query,
  isHighlighted,
  onSelect,
  onMouseEnter,
}: {
  result: SearchResult;
  query: string;
  isHighlighted: boolean;
  onSelect: (threadId: ThreadId) => void;
  onMouseEnter: () => void;
}) {
  const { thread, matchField, matchSnippet } = result;

  const hasPendingApprovals = derivePendingApprovals(thread.activities).length > 0;
  const hasPendingUserInput = derivePendingUserInputs(thread.activities).length > 0;
  const status = threadStatusPill(thread, hasPendingApprovals, hasPendingUserInput);

  return (
    <div
      role="option"
      aria-selected={isHighlighted}
      data-thread-id={thread.id}
      className={`flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none ${
        isHighlighted ? "bg-accent text-accent-foreground" : ""
      }`}
      onClick={() => onSelect(thread.id)}
      onMouseEnter={onMouseEnter}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          {status && (
            <span
              className={`inline-flex shrink-0 items-center gap-1 text-[10px] ${status.colorClass}`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
                  status.pulse ? "animate-pulse" : ""
                }`}
              />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {matchField === "title" ? highlightMatch(thread.title, query) : thread.title}
          </span>
          {thread.branch && (
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground/70">
              <GitBranchIcon className="size-2.5" />
              <span className="max-w-24 truncate">
                {matchField === "branch" ? highlightMatch(thread.branch, query) : thread.branch}
              </span>
            </span>
          )}
          <span className="shrink-0 text-[10px] text-muted-foreground/40">
            {formatRelativeTime(thread.createdAt)}
          </span>
        </div>
        {matchField === "message" && matchSnippet && (
          <span className="truncate text-[11px] text-muted-foreground/50">
            {highlightMatch(matchSnippet, query)}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Main dialog ──────────────────────────────────────────────────────

export default function ThreadSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const threads = useStore((s) => s.threads);
  const projects = useStore((s) => s.projects);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const searchResults = useMemo(
    () => searchThreads(threads, projects, deferredQuery),
    [threads, projects, deferredQuery],
  );

  const grouped = useMemo(() => groupByProject(searchResults, projects), [searchResults, projects]);

  // Flat list of thread IDs for keyboard navigation
  const flatThreadIds = useMemo(() => searchResults.map((r) => r.thread.id), [searchResults]);

  // Reset highlight when results change
  useEffect(() => {
    setHighlightedIndex(0);
  }, [flatThreadIds]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!listRef.current) return;
    const threadId = flatThreadIds[highlightedIndex];
    if (!threadId) return;
    const el = listRef.current.querySelector(`[data-thread-id="${threadId}"]`);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex, flatThreadIds]);

  const handleSelect = useCallback(
    (threadId: ThreadId) => {
      onOpenChange(false);
      setQuery("");
      void navigate({ to: "/$threadId", params: { threadId } });
    },
    [navigate, onOpenChange],
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setQuery("");
        setHighlightedIndex(0);
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const count = flatThreadIds.length;
      if (count === 0) return;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightedIndex((i) => (i + 1) % count);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedIndex((i) => (i - 1 + count) % count);
      } else if (event.key === "Enter") {
        event.preventDefault();
        const threadId = flatThreadIds[highlightedIndex];
        if (threadId) handleSelect(threadId);
      }
    },
    [flatThreadIds, highlightedIndex, handleSelect],
  );

  // Build a flat index counter for mapping grouped results → flat index
  let flatIndex = 0;

  return (
    <CommandDialog open={open} onOpenChange={handleOpenChange}>
      <CommandDialogPopup>
        <div className="flex flex-col">
          {/* Search input */}
          <div className="px-2.5 py-1.5">
            <div className="relative flex items-center">
              <SearchIcon className="pointer-events-none absolute left-3 size-4 text-muted-foreground/60" />
              <input
                ref={inputRef}
                autoFocus
                className="h-10 w-full rounded-md border-transparent bg-transparent pl-9 pr-3 text-base text-foreground placeholder:text-muted-foreground/50 focus:outline-none sm:text-sm"
                placeholder="Search threads..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleKeyDown}
              />
            </div>
          </div>

          {/* Separator */}
          <div className="mx-2.5 h-px bg-border/60" />

          {/* Results */}
          <div className="-mx-px relative min-h-0 rounded-t-xl border border-b-0 border-transparent bg-popover bg-clip-padding">
            <div ref={listRef} role="listbox" className="max-h-72 overflow-y-auto scroll-py-2 p-2">
              {searchResults.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground/60">
                  {deferredQuery ? "No threads found" : "No threads yet"}
                </p>
              )}
              {grouped.map((group) => {
                const groupElement = (
                  <div key={group.project.id} className="[&+&]:mt-1.5">
                    <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                      {group.project.name}
                    </div>
                    {group.results.map((result) => {
                      const currentFlatIndex = flatIndex;
                      flatIndex += 1;
                      return (
                        <ThreadSearchResultRow
                          key={result.thread.id}
                          result={result}
                          query={deferredQuery}
                          isHighlighted={highlightedIndex === currentFlatIndex}
                          onSelect={handleSelect}
                          onMouseEnter={() => setHighlightedIndex(currentFlatIndex)}
                        />
                      );
                    })}
                  </div>
                );
                return groupElement;
              })}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-2 rounded-b-[calc(var(--radius-2xl)-1px)] border-t px-5 py-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-3">
              <span>
                <kbd className="rounded border border-border/60 bg-muted/50 px-1 py-0.5 font-mono text-[10px]">
                  &uarr;&darr;
                </kbd>{" "}
                navigate
              </span>
              <span>
                <kbd className="rounded border border-border/60 bg-muted/50 px-1 py-0.5 font-mono text-[10px]">
                  &crarr;
                </kbd>{" "}
                select
              </span>
              <span>
                <kbd className="rounded border border-border/60 bg-muted/50 px-1 py-0.5 font-mono text-[10px]">
                  esc
                </kbd>{" "}
                close
              </span>
            </span>
            <span className="text-muted-foreground/40">
              {searchResults.length} {searchResults.length === 1 ? "thread" : "threads"}
            </span>
          </div>
        </div>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
