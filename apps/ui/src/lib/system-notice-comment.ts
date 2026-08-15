import type { TaskCommentMetadata, TaskCommentMetadataRow } from "@paperclipai/shared";

type SystemNoticeTone = "neutral" | "info" | "success" | "warning" | "danger";

export type SystemNoticeMetadataRow =
  | { kind: "text"; label: string; value: string }
  | { kind: "code"; label: string; value: string }
  | {
      kind: "task";
      label: string;
      taskNumber: number;
      identifier: string;
      link?: boolean;
      title?: string;
    }
  | {
      kind: "task";
      label: string;
      taskNumber: null;
      identifier: string | null;
      link?: false;
      title?: string;
    }
  | { kind: "agent"; label: string; name: string; agentId?: string }
  | {
      kind: "run";
      label: string;
      runId: string;
      status?: string;
    };

type SystemNoticeMetadataSection = {
  title?: string;
  rows: SystemNoticeMetadataRow[];
};

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

function mapMetadataRow(row: TaskCommentMetadataRow): SystemNoticeMetadataRow | null {
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
      return {
        kind: "run",
        label: metadataRowText(row, "Run"),
        runId: row.runId,
        status: row.title ?? undefined,
      };
    }
    default:
      return null;
  }
}

export function mapCommentMetadataToSystemNoticeSections(
  metadata: TaskCommentMetadata | null | undefined,
): SystemNoticeMetadataSection[] {
  if (!metadata || !Array.isArray(metadata.sections)) return [];
  return metadata.sections
    .map((section) => {
      const rows = section.rows.map(mapMetadataRow).filter((r): r is SystemNoticeMetadataRow => r !== null);
      if (rows.length === 0) return null;
      const out: SystemNoticeMetadataSection = { rows };
      if (section.title) out.title = section.title;
      return out;
    })
    .filter((s): s is SystemNoticeMetadataSection => s !== null);
}

export function systemNoticeLabelForTone(tone: SystemNoticeTone, presentationTitle?: string | null): string {
  const trimmed = presentationTitle?.trim();
  if (trimmed && trimmed.length > 0) return trimmed;
  return TONE_LABEL[tone];
}
