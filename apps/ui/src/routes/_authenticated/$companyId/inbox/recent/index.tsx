import { Inbox } from "@/routes/_authenticated/$companyId/inbox";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/$companyId/inbox/recent/")({
  component: RecentInboxRoute,
});

function RecentInboxRoute() {
  return <Inbox tab="recent" />;
}
