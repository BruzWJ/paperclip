import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Cpu } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { adaptersApi } from "@/api/adapters";
import { useAdapterCatalogSyncState } from "@/adapters/use-adapter-catalog";
import { queryKeys } from "@/lib/queryKeys";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemContent, ItemDescription, ItemFooter, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { publicRuntimeMessage } from "@/lib/public-runtime-message";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";

export const Route = createFileRoute("/_authenticated/$companyId/company/settings/instance/adapters/")({
  component: AdapterManager,
});

function AdapterManager() {
  const companyId = useCompanyRouteId();
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  useAdapterCatalogSyncState();

  useEffect(() => {
    setBreadcrumbs([
      {
        label: selectedCompany?.name ?? "Company",
        renderLink: (content) => (
          <Link to="/$companyId/dashboard" params={{ companyId }}>
            {content}
          </Link>
        ),
      },
      {
        label: "Settings",
        renderLink: (content) => (
          <Link to="/$companyId/company/settings" params={{ companyId }}>
            {content}
          </Link>
        ),
      },
      {
        label: "Instance settings",
        renderLink: (content) => (
          <Link to="/$companyId/company/settings/instance" params={{ companyId }}>
            {content}
          </Link>
        ),
      },
      { label: "Local agents" },
    ]);
  }, [companyId, selectedCompany?.name, setBreadcrumbs]);

  const {
    data: adapters,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Spinner />
        Loading local agent catalog...
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Cpu className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Local agents</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Paperclip discovers compatible local agents, models, session settings, and their resolved execution
          contracts automatically, then supervises those executions.
        </p>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {error instanceof Error
              ? publicRuntimeMessage(error.message)
              : "The local agent catalog is unavailable."}
          </AlertDescription>
        </Alert>
      ) : !adapters?.length ? (
        <Card>
          <CardContent>
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No compatible local agents</EmptyTitle>
                <EmptyDescription>
                  Install and authenticate a compatible agent CLI on this host, then retry.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent>
            <ItemGroup className="gap-3">
              {adapters.map((adapter) => {
                const isReady = adapter.loaded;
                return (
                  <Item key={adapter.type} variant="outline">
                    <ItemContent>
                      <ItemTitle>
                        {adapter.label}
                        <Badge variant="outline">Local runtime contract</Badge>
                        <Badge variant={isReady ? "secondary" : "destructive"}>
                          {isReady
                            ? "Ready"
                            : adapter.diagnostic.code === "acpx_catalog_invalid"
                              ? "Catalog metadata rejected"
                              : "Probe failed"}
                        </Badge>
                      </ItemTitle>
                      <ItemDescription>
                        {isReady ? (
                          <>
                            Agent runtime name <code>{adapter.type}</code> · {adapter.modelsCount} reported
                            model
                            {adapter.modelsCount === 1 ? "" : "s"}
                          </>
                        ) : (
                          <>
                            Agent runtime name <code>{adapter.type}</code> · not selectable until its local
                            readiness check and catalog admission succeed
                          </>
                        )}
                      </ItemDescription>
                    </ItemContent>

                    <ItemFooter>
                      {isReady ? (
                        <Badge variant="secondary">
                          {adapter.capabilities.runtimeControls.length} runtime controls
                        </Badge>
                      ) : (
                        <Alert variant="destructive">
                          <AlertDescription>
                            <span className="font-medium">Local agent diagnostic:</span>{" "}
                            {publicRuntimeMessage(adapter.diagnostic.message)}
                          </AlertDescription>
                        </Alert>
                      )}
                    </ItemFooter>
                  </Item>
                );
              })}
            </ItemGroup>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
