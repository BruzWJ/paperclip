import type { ComponentProps, ReactNode } from "react";

import { Status, StatusIndicator, StatusLabel } from "@/components/kibo-ui/status";
import { domainStatusTone } from "@/lib/domain-status";

export interface DomainStatusProps extends Omit<
  ComponentProps<typeof Status>,
  "children" | "status" | "variant"
> {
  status: string;
  children?: ReactNode;
}

function defaultStatusLabel(status: string) {
  return status.replace(/[_-]/g, " ");
}

/** Paperclip status adapter backed by Kibo's Status composition. */
export function DomainStatus({ status, children, ...props }: DomainStatusProps) {
  return (
    <Status status={domainStatusTone(status)} {...props}>
      <StatusIndicator aria-hidden="true" />
      <StatusLabel>{children ?? defaultStatusLabel(status)}</StatusLabel>
    </Status>
  );
}
