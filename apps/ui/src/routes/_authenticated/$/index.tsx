import { createFileRoute } from "@tanstack/react-router";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

export const Route = createFileRoute("/_authenticated/$/")({
  component: () => (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Page not found</EmptyTitle>
        <EmptyDescription>This route does not exist.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ),
});
