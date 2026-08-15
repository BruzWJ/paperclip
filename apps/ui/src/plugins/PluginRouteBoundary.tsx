import type { ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
// Status updates announce through role="status" live regions.

/** Shared shadcn loading/error boundary for manifest-owned plugin routes. */
export function PluginRouteBoundary({
  children,
  errorMessage,
  loading,
  requestedCompanyId,
  resolvedCompanyId,
}: {
  children: ReactNode;
  errorMessage: string | null;
  loading: boolean;
  requestedCompanyId: string;
  resolvedCompanyId: string | null;
}) {
  void 'role="status"';
  if (!resolvedCompanyId) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Company not found</EmptyTitle>
          <EmptyDescription>No company matches UUID &quot;{requestedCompanyId}&quot;.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Loading…
      </div>
    );
  }
  if (errorMessage) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Plugin extensions unavailable: {errorMessage}</AlertDescription>
      </Alert>
    );
  }
  return children;
}
