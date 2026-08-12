import { createFileRoute } from "@tanstack/react-router";
import { Approvals } from "@/routes/_authenticated/$companyId/approvals";

export const Route = createFileRoute(
  "/_authenticated/$companyId/approvals/all/",
)({ component: AllApprovalsRoute });

function AllApprovalsRoute() {
  return <Approvals statusFilter="all" />;
}
