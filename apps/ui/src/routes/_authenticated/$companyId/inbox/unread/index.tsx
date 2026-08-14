import { Inbox } from "@/routes/_authenticated/$companyId/inbox";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/$companyId/inbox/unread/")({
  component: UnreadInboxRoute,
});

function UnreadInboxRoute() {
  return <Inbox tab="unread" />;
}
