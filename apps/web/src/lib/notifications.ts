import type { OrchestrationThreadActivity, OrchestrationSessionStatus } from "@t3tools/contracts";

export function requestNotificationPermission(): void {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    void Notification.requestPermission();
  }
}

function shouldNotify(): boolean {
  if (!("Notification" in window)) return false;
  if (Notification.permission !== "granted") return false;
  if (document.hasFocus()) return false;
  return true;
}

function fireNotification(title: string, body: string, tag: string, onNavigate?: () => void): void {
  const n = new Notification(title, { body, tag });
  n.onclick = () => {
    window.focus();
    onNavigate?.();
    n.close();
  };
  setTimeout(() => n.close(), 8_000);
}

// ── Activity-based notifications (approvals, user input) ─────────────

function buildActivityNotification(
  activity: OrchestrationThreadActivity,
  threadTitle: string,
): { title: string; body: string } | null {
  switch (activity.kind) {
    case "approval.requested": {
      const payload = activity.payload as { requestKind?: string } | null;
      const detail = payload?.requestKind ? ` (${payload.requestKind})` : "";
      return { title: `Approval needed${detail}`, body: threadTitle };
    }
    case "user-input.requested": {
      return { title: "Input requested", body: threadTitle };
    }
    default:
      return null;
  }
}

export function dispatchActivityNotification(
  activity: OrchestrationThreadActivity,
  threadTitle: string,
  onNavigate?: () => void,
): void {
  if (!shouldNotify()) return;
  const notification = buildActivityNotification(activity, threadTitle);
  if (!notification) return;
  fireNotification(
    notification.title,
    notification.body,
    activity.turnId ?? activity.id,
    onNavigate,
  );
}

// ── Session-set notifications (turn finished) ────────────────────────

/**
 * Notify when a session transitions from "running" to a settled state,
 * indicating the turn has finished.
 */
export function dispatchSessionSetNotification(
  threadId: string,
  threadTitle: string,
  status: OrchestrationSessionStatus,
  previousStatus: OrchestrationSessionStatus | null,
  onNavigate?: () => void,
): void {
  if (!shouldNotify()) return;
  if (previousStatus !== "running") return;

  let title: string;
  switch (status) {
    case "ready":
      title = "Turn completed";
      break;
    case "error":
      title = "Turn failed";
      break;
    case "stopped":
      title = "Session stopped";
      break;
    default:
      return;
  }

  fireNotification(title, threadTitle, `session:${threadId}`, onNavigate);
}
