import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia } from "@/components/ui/item";
import { type RoutineRevision } from "@paperclipai/shared";
import { Check, RotateCcw, TriangleAlert } from "lucide-react";

import { formatEnvDiffCounts } from "./RoutineRevisionDiff";

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
  onConfirm: () => void;
  pending: boolean;
  recreatedWebhookLabels: string[];
  envDiffCounts: EnvDiffCounts;
}) {
  const newRevisionNumber = currentRevisionNumber + 1;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore revision {target.revisionNumber}?</AlertDialogTitle>
          <AlertDialogDescription>
            This creates a new revision {newRevisionNumber} with the same content as revision{" "}
            {target.revisionNumber}. Revisions {target.revisionNumber}–{currentRevisionNumber} stay in history
            and are not modified.
          </AlertDialogDescription>
        </AlertDialogHeader>
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
        <Field>
          <FieldLabel htmlFor="restore-change-summary">Change summary (optional)</FieldLabel>
          <Input
            id="restore-change-summary"
            value={changeSummary}
            placeholder="Why are you restoring? Visible in history."
            onChange={(event) => onChangeSummaryChange(event.target.value)}
          />
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={pending}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            {pending ? "Restoring…" : `Restore as revision ${newRevisionNumber}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type EnvDiffCounts = {
  added: number;
  removed: number;
  changed: number;
  total: number;
};
