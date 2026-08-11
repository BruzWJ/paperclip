import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cpu } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { adaptersApi, type AdapterInfo } from "@/api/adapters";
import { useAdapterCatalogSyncState } from "@/adapters/use-adapter-catalog";
import { queryKeys } from "@/lib/queryKeys";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { publicRuntimeMessage } from "@/lib/public-runtime-message";

function AdapterCatalogRow({ adapter }: { adapter: AdapterInfo }) {
  const isReady = adapter.loaded;
  return (
    <li className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{adapter.label}</span>
            <Badge variant="outline">Local runtime contract</Badge>
            <Badge
              variant="secondary"
              className={isReady ? "text-green-700" : "text-destructive"}
            >
              {isReady
                ? "Ready"
                : adapter.diagnostic.code === "acpx_catalog_invalid"
                  ? "Catalog metadata rejected"
                  : "Probe failed"}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {isReady ? (
              <>
                Agent runtime name <code>{adapter.type}</code> · {adapter.modelsCount} reported model{adapter.modelsCount === 1 ? "" : "s"}
              </>
            ) : (
              <>
                Agent runtime name <code>{adapter.type}</code> · not selectable until its local readiness check and catalog admission succeed
              </>
            )}
          </p>
        </div>
        <code className="rounded bg-muted px-2 py-1 text-xs">
          {adapter.registryName}
        </code>
      </div>

      {isReady ? (
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary">
            {adapter.capabilities.runtimeControls.length} runtime controls
          </Badge>
        </div>
      ) : (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span className="font-medium">Local agent diagnostic:</span>{" "}
          {publicRuntimeMessage(adapter.diagnostic.message)}
        </div>
      )}
    </li>
  );
}

export function AdapterManager() {
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  useAdapterCatalogSyncState();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Local agents" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const { data: adapters, isLoading, error } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
  });

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading local agent catalog...</div>;
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Cpu className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Local agents</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Paperclip discovers compatible local agents, models, session settings,
          and their resolved execution contracts automatically, then supervises
          those executions.
        </p>
      </div>

      {error ? (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            {error instanceof Error
              ? publicRuntimeMessage(error.message)
              : "The local agent catalog is unavailable."}
          </CardContent>
        </Card>
      ) : !adapters?.length ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No compatible local agent is currently available. Install and authenticate a compatible agent CLI on this host, then retry.
          </CardContent>
        </Card>
      ) : (
        <Card className="block py-0">
          <ul className="divide-y">{adapters.map((adapter) => (
            <AdapterCatalogRow key={adapter.type} adapter={adapter} />
          ))}</ul>
        </Card>
      )}
    </div>
  );
}
