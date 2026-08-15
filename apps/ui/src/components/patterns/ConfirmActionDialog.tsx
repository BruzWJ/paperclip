import { useRef, useState, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/ui/spinner";

export interface ConfirmActionDialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  triggerAsChild?: boolean;
  title: ReactNode;
  description?: ReactNode;
  descriptionAsChild?: boolean;
  children?: ReactNode;
  confirmLabel?: ReactNode;
  pendingLabel?: ReactNode;
  cancelLabel?: ReactNode;
  variant?: "default" | "destructive";
  disabled?: boolean;
  pending?: boolean;
  onConfirm: () => void | Promise<void>;
}

/**
 * Canonical confirmation pattern for domain actions.
 *
 * Registry primitives own the dialog's layout and accessibility. This wrapper
 * owns only the repeated confirmation contract, including keeping the dialog
 * mounted while an asynchronous action is in flight.
 */
export function ConfirmActionDialog({
  open,
  defaultOpen = false,
  onOpenChange,
  trigger,
  triggerAsChild = false,
  title,
  description,
  descriptionAsChild = false,
  children,
  confirmLabel = "Confirm",
  pendingLabel,
  cancelLabel = "Cancel",
  variant = "default",
  disabled = false,
  pending = false,
  onConfirm,
}: ConfirmActionDialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const [confirming, setConfirming] = useState(false);
  const confirmingRef = useRef(false);
  const isControlled = open !== undefined;
  const resolvedOpen = isControlled ? open : uncontrolledOpen;
  const isPending = pending || confirming;

  const commitOpenChange = (nextOpen: boolean) => {
    if (!isControlled) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isPending) return;
    commitOpenChange(nextOpen);
  };

  const handleConfirm = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (disabled || pending || confirmingRef.current) return;

    confirmingRef.current = true;
    setConfirming(true);
    let succeeded = false;

    try {
      await onConfirm();
      succeeded = true;
    } catch {
      // Domain mutations own error presentation. A rejected confirmation stays
      // open so the user can retry or cancel after reviewing that feedback.
    } finally {
      confirmingRef.current = false;
      setConfirming(false);
    }

    if (succeeded) commitOpenChange(false);
  };

  return (
    <AlertDialog open={resolvedOpen} onOpenChange={handleOpenChange}>
      {trigger !== undefined ? (
        <AlertDialogTrigger asChild={triggerAsChild}>{trigger}</AlertDialogTrigger>
      ) : null}
      <AlertDialogContent aria-busy={isPending || undefined}>
        <p aria-live="polite" className="sr-only">
          {isPending ? (pendingLabel ?? "Working…") : ""}
        </p>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description !== undefined ? (
            <AlertDialogDescription asChild={descriptionAsChild}>
              {descriptionAsChild ? <div>{description}</div> : description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction variant={variant} disabled={disabled || isPending} onClick={handleConfirm}>
            {isPending ? (
              <span className="inline-flex items-center gap-2" role="status">
                <Spinner />
                {pendingLabel !== undefined ? pendingLabel : confirmLabel}
              </span>
            ) : (
              confirmLabel
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
