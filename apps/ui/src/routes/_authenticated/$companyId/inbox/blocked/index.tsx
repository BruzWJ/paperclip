import { createFileRoute } from "@tanstack/react-router";
import { Inbox } from "@/routes/_authenticated/$companyId/inbox";

export const Route = createFileRoute(
  "/_authenticated/$companyId/inbox/blocked/",
)({ component: BlockedInboxRoute });

function BlockedInboxRoute() {
  return <Inbox tab="blocked" />;
}
