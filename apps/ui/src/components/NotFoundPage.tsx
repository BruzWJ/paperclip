import { useEffect } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { AlertTriangle, Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";

type NotFoundScope = "board" | "invalid_company_id" | "global";

interface NotFoundPageProps {
  scope?: NotFoundScope;
  requestedCompanyId?: string;
}

function BoardDashboardButton() {
  const companyId = useCompanyRouteId();

  return (
    <Button asChild>
      <Link to="/$companyId/dashboard" params={{ companyId }}>
        <Compass data-icon="inline-start" className="mr-1.5 h-4 w-4" />
        Open dashboard
      </Link>
    </Button>
  );
}

export function NotFoundPage({
  scope = "global",
  requestedCompanyId,
}: NotFoundPageProps) {
  const location = useLocation();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Not Found" }]);
  }, [setBreadcrumbs]);

  const currentPath = `${location.pathname}${location.searchStr}${location.hash ? `#${location.hash}` : ""}`;
  const title =
    scope === "invalid_company_id" ? "Company not found" : "Page not found";
  const description =
    scope === "invalid_company_id"
      ? `No company matches UUID "${requestedCompanyId ?? "unknown"}".`
      : "This route does not exist.";

  return (
    <div className="mx-auto max-w-2xl py-10">
      <Card className="block p-6">
        <div className="flex items-center gap-3">
          <div className="rounded-md border border-destructive/20 bg-destructive/10 p-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{title}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        </div>

        <div className="mt-4 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          Requested path: <code className="font-mono">{currentPath}</code>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {scope === "board" ? <BoardDashboardButton /> : null}
          <Button variant="outline" asChild>
            <Link to="/">Open board</Link>
          </Button>
        </div>
      </Card>
    </div>
  );
}
