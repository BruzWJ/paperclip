import { useEffect, useId, useState } from "react";

import { DomainStatus } from "@/components/patterns/DomainStatus";
import { FormDialog, LabeledFormField } from "@/components/patterns/FormPatterns";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { taskValueLabel } from "@/lib/task-blockers";
import { taskLifecycleStatusTargets, type Task, type UpdateTaskStatus } from "@paperclipai/shared";

type TaskLifecycleStatus = Task["lifecycleStatus"];
type TaskStatusRecipient = UpdateTaskStatus["recipient"];

export interface StatusRecipientOption {
  value: TaskStatusRecipient;
  label: string;
  disabled?: boolean;
}

function statusLabel(status: TaskLifecycleStatus, current: TaskLifecycleStatus) {
  return status === "open" && (current === "done" || current === "cancelled")
    ? "Continue task"
    : taskValueLabel(status);
}

export function TaskStatusUpdateDialog({
  task,
  recipients,
  pending,
  onSubmit,
}: {
  task: Pick<Task, "lifecycleStatus">;
  recipients: readonly StatusRecipientOption[];
  pending: boolean;
  onSubmit: (input: UpdateTaskStatus) => Promise<unknown>;
}) {
  const formId = useId();
  const statusId = `${formId}-status`;
  const messageId = `${formId}-message`;
  const recipientId = `${formId}-recipient`;
  const statusOptions = taskLifecycleStatusTargets(task.lifecycleStatus);
  const firstRecipient = recipients.find((option) => !option.disabled)?.value ?? "";
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<TaskLifecycleStatus | "">("");
  const [message, setMessage] = useState("");
  const [recipient, setRecipient] = useState<TaskStatusRecipient | "">(firstRecipient);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (open && !recipients.some((option) => option.value === recipient && !option.disabled)) {
      setRecipient(firstRecipient);
    }
  }, [firstRecipient, open, recipient, recipients]);

  const canSubmit = Boolean(status && message.trim() && recipient && !pending);

  const resetDraft = () => {
    setStatus("");
    setMessage("");
    setRecipient(firstRecipient);
    setIdempotencyKey(crypto.randomUUID());
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (pending) return;
    if (nextOpen && !open) resetDraft();
    setOpen(nextOpen);
  };

  const handleSubmit = async () => {
    if (!canSubmit || !status || !recipient) return;
    try {
      await onSubmit({ status, message, recipient, idempotencyKey });
      setOpen(false);
    } catch {
      // The mutation displays the error and this intact draft can be retried.
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Update status"
      description="Choose a new status, add context, and select the agent to notify."
      contentProps={{ showCloseButton: !pending }}
      trigger={
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="min-h-11 sm:min-h-8"
        >
          Update
        </Button>
      }
      triggerAsChild
      footer={
        <>
          {pending ? (
            <p role="status" className="sr-only">
              Updating task status…
            </p>
          ) : null}
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!canSubmit}>
            {pending ? "Updating…" : "Update status"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="space-y-5 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <LabeledFormField label="Status" labelFor={statusId} requiredIndicator>
          <Select
            value={status}
            onValueChange={(value) => setStatus(value as TaskLifecycleStatus)}
            disabled={pending}
          >
            <SelectTrigger id={statusId} className="w-full min-w-0" aria-required="true">
              <SelectValue placeholder="Select a status" />
            </SelectTrigger>
            <SelectContent>
              {statusOptions.map((option) => (
                <SelectItem key={option} value={option}>
                  <DomainStatus status={option}>{statusLabel(option, task.lifecycleStatus)}</DomainStatus>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </LabeledFormField>

        <LabeledFormField
          label="Message"
          labelFor={messageId}
          description="Explain what changed and what you need next."
          requiredIndicator
        >
          <Textarea
            id={messageId}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Add context for this status change…"
            rows={4}
            required
            disabled={pending}
          />
        </LabeledFormField>

        <LabeledFormField
          label="Send to"
          labelFor={recipientId}
          description="Only agent recipients are available to prevent self-invocation."
          requiredIndicator
        >
          <Select
            value={recipient}
            onValueChange={(value) => setRecipient(value as TaskStatusRecipient)}
            disabled={pending}
          >
            <SelectTrigger id={recipientId} className="w-full min-w-0" aria-required="true">
              <SelectValue placeholder="Select a recipient" />
            </SelectTrigger>
            <SelectContent>
              {recipients.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </LabeledFormField>
      </form>
    </FormDialog>
  );
}
