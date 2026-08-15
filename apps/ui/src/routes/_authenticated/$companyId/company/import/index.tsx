import { CompanyImportView } from "@/routes/_authenticated/$companyId/company/import/-CompanyImportView";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { useCompanyImportController } from "./-useCompanyImportController";

export const Route = createFileRoute("/_authenticated/$companyId/company/import/")({
  component: CompanyImport,
});

function CompanyImport() {
  const controller = useCompanyImportController();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      {
        label: "Agents",
        renderLink: (content) => (
          <Link to="/$companyId/agents" params={{ companyId: controller.companyId }}>
            {content}
          </Link>
        ),
      },
      { label: "Import" },
    ]);
  }, [controller.companyId, setBreadcrumbs]);

  return <CompanyImportView controller={controller} />;
}
