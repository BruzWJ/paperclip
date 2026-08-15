import type {
  TaskCommentMetadata,
  TaskCommentMetadataRow,
  TaskCommentPresentation,
} from "@paperclipai/shared";
import type {
  SystemNoticeMetadataRow,
  SystemNoticeMetadataSection,
  SystemNoticeProps,
  SystemNoticeTone,
} from "../features/task-chat/SystemNotice";

const TONE_LABEL: Record<SystemNoticeTone, string> = {
  neutral: "System notice",
  info: "System notice",
  success: "System notice",
  warning: "System warning",
  danger: "System alert",
};

function metadataRowText(row: { label?: string | null }, fallback: string) {
  const label = row.label?.trim();
  return label && label.length > 0 ? label : fallback;
}

function mapMetadataRow(
  row: TaskCommentMetadataRow,
  ctx: {
    runAgentId?: string | null;
  },
): SystemNoticeMetadataRow | null {
  switch (row.type) {
    case "text":
      return { kind: "text", label: metadataRowText(row, "Detail"), value: row.text };
    case "code":
      return { kind: "code", label: metadataRowText(row, "Code"), value: row.code };
    case "key_value":
      return { kind: "text", label: row.label, value: row.value };
    case "task_link": {
      if (row.taskNumber !== null) {
        return {
          kind: "task",
          label: metadataRowText(row, "Task"),
          taskNumber: row.taskNumber,
          identifier: row.identifier,
          link: true,
          title: row.title ?? undefined,
        };
      }
      return {
        kind: "task",
        label: metadataRowText(row, "Task"),
        taskNumber: null,
        identifier: row.identifier ?? null,
        link: false,
        title: row.title ?? undefined,
      };
    }
    case "agent_link": {
      const name = row.name?.trim() || "Unknown agent";
      return {
        kind: "agent",
        label: metadataRowText(row, "Agent"),
        name,
        agentId: row.agentId,
      };
    }
    case "run_link": {
      const runAgentId = ctx.runAgentId ?? null;
      return {
        kind: "run",
        label: metadataRowText(row, "Run"),
        runId: row.runId,
        agentId: runAgentId ?? undefined,
        status: row.title ?? undefined,
      };
    }
    default:
      return null;
  }
}

export function mapCommentMetadataToSystemNoticeSections(
  metadata: TaskCommentMetadata | null | undefined,
  ctx: {
    runAgentId?: string | null;
  } = {},
): SystemNoticeMetadataSection[] {
  if (!metadata || !Array.isArray(metadata.sections)) return [];
  return metadata.sections
    .map((section) => {
      const rows = section.rows
        .map((row) => mapMetadataRow(row, ctx))
        .filter((r): r is SystemNoticeMetadataRow => r !== null);
      if (rows.length === 0) return null;
      const out: SystemNoticeMetadataSection = { rows };
      if (section.title) out.title = section.title;
      return out;
    })
    .filter((s): s is SystemNoticeMetadataSection => s !== null);
}

export function systemNoticeLabelForTone(
  tone: SystemNoticeTone,
  presentationTitle?: string | null,
): string {
  const trimmed = presentationTitle?.trim();
  if (trimmed && trimmed.length > 0) return trimmed;
  return TONE_LABEL[tone];
}

export function buildSystemNoticeProps(input: {
  presentation: TaskCommentPresentation | null;
  metadata: TaskCommentMetadata | null;
  body: import("react").ReactNode;
  timestamp?: string;
  source?: SystemNoticeProps["source"];
  runAgentId?: string | null;
}): SystemNoticeProps {
  const tone: SystemNoticeTone = input.presentation?.tone ?? "neutral";
  const label = systemNoticeLabelForTone(tone, input.presentation?.title);
  const detailsDefaultOpen = Boolean(input.presentation?.detailsDefaultOpen);
  const sections = mapCommentMetadataToSystemNoticeSections(input.metadata, {
    runAgentId: input.runAgentId ?? null,
  });
  return {
    tone,
    label,
    body: input.body,
    metadata: sections.length > 0 ? sections : undefined,
    detailsDefaultOpen,
    timestamp: input.timestamp,
    source: input.source,
  };
}
