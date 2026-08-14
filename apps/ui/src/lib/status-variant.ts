import type { ComponentProps } from "react";

import type { Badge } from "@/components/ui/badge";

type BadgeVariant = ComponentProps<typeof Badge>["variant"];

const destructiveStatuses = new Set([
  "blocked",
  "denied",
  "error",
  "failed",
  "hard_stop",
  "quarantined",
  "rejected",
  "runtime-error",
  "terminated",
  "timed_out",
]);

const outlineStatuses = new Set([
  "archived",
  "backlog",
  "cancelled",
  "draft",
  "hidden",
  "idle",
  "planned",
  "unchecked",
]);

const secondaryStatuses = new Set([
  "deferred",
  "degraded",
  "in_review",
  "paused",
  "pending",
  "pending_approval",
  "queued",
  "rate-limit",
  "redacted",
  "require-approval",
  "revision_requested",
  "scheduled_retry",
  "todo",
  "warning",
]);

export function statusBadgeVariant(status: string): BadgeVariant {
  if (destructiveStatuses.has(status)) return "destructive";
  if (outlineStatuses.has(status)) return "outline";
  if (secondaryStatuses.has(status)) return "secondary";
  return "default";
}
