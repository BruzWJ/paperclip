import { ConfirmActionDialog } from "@/components/patterns/ConfirmActionDialog";
import { Input } from "@/components/ui/input";
import { LabeledFormField } from "@/components/patterns/FormPatterns";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia } from "@/components/ui/item";
import { type RoutineRevision } from "@paperclipai/shared";
import { Check, RotateCcw, TriangleAlert } from "lucide-react";

import { formatEnvDiffCounts } from "./-RoutineRevisionDiff";
import type { EnvDiffCounts } from "@/lib/presentation-contracts";

export function RestoreConfirmDialog({
  open,
  onOpenChange,
  target,
  currentRevisionNumber,
  changeSummary,
  onChangeSummaryChange,
  onConfirm,
  pending,
  recreatedWebhookLabels,
  envDiffCounts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: RoutineRevision;
  currentRevisionNumber: number;
  changeSummary: string;
  onChangeSummaryChange: (value: string) => void;
  onConfirm: () => Promise<void>;
  pending: boolean;
  recreatedWebhookLabels: string[];
  envDiffCounts: EnvDiffCounts;
}) {
  const newRevisionNumber = currentRevisionNumber + 1;
  return (
    <ConfirmActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Restore revision ${target.revisionNumber}?`}
      description={`This creates a new revision ${newRevisionNumber} with the same content as revision ${target.revisionNumber}. Revisions ${target.revisionNumber}–${currentRevisionNumber} stay in history and are not modified.`}
      confirmLabel={
        <>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5"  data-icon="inline-start"/>
          Restore as revision {newRevisionNumber}
        </>
      }
      pendingLabel="Restoring…"
      pending={pending}
      onConfirm={onConfirm}
    >
      <ItemGroup>
        {[
          {
            key: "fields",
            warning: false,
            content: "Routine field values, variables, and schedule cron will revert.",
          },
          ...(envDiffCounts.total > 0
            ? [
                {
                  key: "secrets",
                  warning: false,
                  content: `Routine secrets will revert: ${formatEnvDiffCounts(envDiffCounts)}.`,
                },
              ]
            : []),
          {
            key: "history",
            warning: false,
            content: "Previous run history is preserved.",
          },
          ...recreatedWebhookLabels.map((label) => ({
            key: label,
            warning: true,
            content: `The webhook trigger ${label} will be recreated with a new URL and secret. Paperclip will show the secret once after restore — copy it before closing.`,
          })),
        ].map(({ key, warning, content }) => {
          const Icon = warning ? TriangleAlert : Check;
          return (
            <Item key={key} size="sm" variant={warning ? "muted" : "default"}>
              <ItemMedia variant="icon">
                <Icon />
              </ItemMedia>
              <ItemContent>
                <ItemDescription>{content}</ItemDescription>
              </ItemContent>
            </Item>
          );
        })}
      </ItemGroup>
      <LabeledFormField label="Change summary (optional)" labelFor="restore-change-summary">
        <Input aria-label="restore change summary"
          id="restore-change-summary"
          value={changeSummary}
          placeholder="Why are you restoring? Visible in history."
          onChange={(event) => onChangeSummaryChange(event.target.value)}
        />
      </LabeledFormField>
    </ConfirmActionDialog>
  );
}
