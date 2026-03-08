import type { ThreadId, ProjectId } from "@t3tools/contracts";
import { projectTerminalThreadId } from "../types";

interface TerminalRetentionThread {
  id: ThreadId;
  deletedAt: string | null;
}

interface CollectActiveTerminalThreadIdsInput {
  snapshotThreads: readonly TerminalRetentionThread[];
  draftThreadIds: Iterable<ThreadId>;
  projectIds?: Iterable<ProjectId>;
}

export function collectActiveTerminalThreadIds(
  input: CollectActiveTerminalThreadIdsInput,
): Set<ThreadId> {
  const activeThreadIds = new Set<ThreadId>();
  for (const thread of input.snapshotThreads) {
    if (thread.deletedAt !== null) continue;
    activeThreadIds.add(thread.id);
  }
  for (const draftThreadId of input.draftThreadIds) {
    activeThreadIds.add(draftThreadId);
  }
  if (input.projectIds) {
    for (const projectId of input.projectIds) {
      activeThreadIds.add(projectTerminalThreadId(projectId));
    }
  }
  return activeThreadIds;
}
