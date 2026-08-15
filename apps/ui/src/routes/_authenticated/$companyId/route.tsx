import { isCanonicalUuid } from "@paperclipai/shared";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Layout } from "@/routes/_authenticated/$companyId/-shell/-Layout";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

export const Route = createFileRoute("/_authenticated/$companyId")({
  loader: ({ params }) => {
    if (!isCanonicalUuid(params.companyId)) throw notFound();
  },
  component: Layout,
  notFoundComponent: () => (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Page not found</EmptyTitle>
        <EmptyDescription>This company page does not exist.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ),
});
