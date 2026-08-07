import { type MouseEvent } from "react";
import { Button } from "./ui/button";

export interface JoinRequestApprovalControlsProps {
  onApprove: () => void;
  onReject: () => void;
  isPending: boolean;
  approveLabel?: string;
  rejectLabel?: string;
  className?: string;
  buttonClassName?: string;
  onClickCapture?: (event: MouseEvent<HTMLDivElement>) => void;
}

export function JoinRequestApprovalControls({
  onApprove,
  onReject,
  isPending,
  approveLabel = "Approve",
  rejectLabel = "Reject",
  className = "flex flex-wrap items-center gap-2",
  buttonClassName,
  onClickCapture,
}: JoinRequestApprovalControlsProps) {
  return (
    <div className={className} onClickCapture={onClickCapture}>
      <Button
        size="sm"
        className={buttonClassName}
        onClick={onApprove}
        disabled={isPending}
      >
        {approveLabel}
      </Button>
      <Button
        variant="destructive"
        size="sm"
        className={buttonClassName}
        onClick={onReject}
        disabled={isPending}
      >
        {rejectLabel}
      </Button>
    </div>
  );
}
