import type { TaskWorkMode } from "@paperclipai/shared";
import { ClipboardList, Hammer, MessageCircleQuestion, type LucideIcon } from "lucide-react";

export interface WorkModeMeta {
  value: TaskWorkMode;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
}

export function isTaskWorkMode(value: unknown): value is TaskWorkMode {
  return value === "standard" || value === "ask" || value === "planning";
}

export function workModeMetaList(): WorkModeMeta[] {
  return [
    {
      value: "standard",
      label: "Agent mode",
      shortLabel: "Agent",
      icon: Hammer,
    },
    {
      value: "planning",
      label: "Plan mode",
      shortLabel: "Plan",
      icon: ClipboardList,
    },
    {
      value: "ask",
      label: "Ask mode",
      shortLabel: "Ask",
      icon: MessageCircleQuestion,
    },
  ];
}

export function workModeMetaFor(mode: TaskWorkMode): WorkModeMeta {
  const modes = workModeMetaList();
  return modes.find((meta) => meta.value === mode) ?? modes[0]!;
}

export function nextWorkMode(mode: TaskWorkMode): TaskWorkMode {
  const modes = workModeMetaList();
  const index = modes.findIndex((meta) => meta.value === mode);
  return modes[(index + 1) % modes.length]?.value ?? "standard";
}
