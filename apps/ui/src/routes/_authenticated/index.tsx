import { createFileRoute, Navigate } from "@tanstack/react-router";
import {
  ROOT_REDIRECT_COMPANY_STORAGE_KEY,
  resolveRootRedirectCompanyId,
  useCompany,
} from "@/context/CompanyContext";
import { Spinner } from "@/components/ui/spinner";

function CompanyRootRedirect() {
  const { companies, loading } = useCompany();

  if (loading) {
    return (
      <div className="mx-auto flex max-w-xl items-center gap-2 py-10 text-sm text-muted-foreground">
        <Spinner />
        Loading...
      </div>
    );
  }

  const sidebarCompanies = companies.filter((company) => company.status !== "archived");
  const targetCompanyId = resolveRootRedirectCompanyId({
    companies,
    sidebarCompanies,
    storedCompanyId: localStorage.getItem(ROOT_REDIRECT_COMPANY_STORAGE_KEY),
  });
  if (!targetCompanyId) {
    return <Navigate to="/onboarding" replace />;
  }

  return <Navigate to="/$companyId/dashboard" params={{ companyId: targetCompanyId }} replace />;
}

export const Route = createFileRoute("/_authenticated/")({
  component: CompanyRootRedirect,
});
