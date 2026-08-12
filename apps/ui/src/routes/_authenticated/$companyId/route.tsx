import { isCanonicalUuid } from "@paperclipai/shared";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Layout } from "@/components/Layout";
import { NotFoundPage } from "@/components/NotFoundPage";

export const Route = createFileRoute("/_authenticated/$companyId")({
  loader: ({ params }) => {
    if (!isCanonicalUuid(params.companyId)) throw notFound();
  },
  component: Layout,
  notFoundComponent: () => <NotFoundPage scope="board" />,
});
