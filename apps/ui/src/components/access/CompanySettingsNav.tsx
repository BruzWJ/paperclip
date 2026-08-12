import { PageTabBar } from "@/components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";

const items = [
  {
    value: "general",
    label: "General",
    to: "/$companyId/company/settings",
  },
  {
    value: "members",
    label: "Members",
    to: "/$companyId/company/settings/members",
  },
  {
    value: "invites",
    label: "Invites",
    to: "/$companyId/company/settings/invites",
  },
  {
    value: "secrets",
    label: "Secrets",
    to: "/$companyId/company/settings/secrets",
  },
  {
    value: "instance-profile",
    label: "Instance profile",
    to: "/$companyId/company/settings/instance/profile",
  },
  {
    value: "instance-general",
    label: "Instance general",
    to: "/$companyId/company/settings/instance",
  },
  {
    value: "instance-access",
    label: "Instance access",
    to: "/$companyId/company/settings/instance/access",
  },
  {
    value: "instance-plugins",
    label: "Instance plugins",
    to: "/$companyId/company/settings/instance/plugins",
  },
  {
    value: "instance-adapters",
    label: "Instance adapters",
    to: "/$companyId/company/settings/instance/adapters",
  },
] as const;

type CompanySettingsTab = (typeof items)[number]["value"];

export function CompanySettingsNav() {
  const matchRoute = useMatchRoute();
  const navigate = useNavigate();
  const companyId = useCompanyRouteId();
  const routeParams = { companyId };
  const activeTab: CompanySettingsTab | null = matchRoute({
    to: "/$companyId/company/settings/instance/profile",
    params: routeParams,
    fuzzy: false,
  })
    ? "instance-profile"
    : matchRoute({
          to: "/$companyId/company/settings/instance/access",
          params: routeParams,
          fuzzy: false,
        })
      ? "instance-access"
      : matchRoute({
            to: "/$companyId/company/settings/instance/adapters",
            params: routeParams,
            fuzzy: false,
          })
        ? "instance-adapters"
        : matchRoute({
              to: "/$companyId/company/settings/instance/plugins",
              params: routeParams,
              fuzzy: true,
            })
          ? "instance-plugins"
          : matchRoute({
                to: "/$companyId/company/settings/instance",
                params: routeParams,
                fuzzy: false,
              })
            ? "instance-general"
            : matchRoute({
                  to: "/$companyId/company/settings/members",
                  params: routeParams,
                  fuzzy: false,
                })
              ? "members"
              : matchRoute({
                    to: "/$companyId/company/settings/invites",
                    params: routeParams,
                    fuzzy: false,
                  })
                ? "invites"
                : matchRoute({
                      to: "/$companyId/company/settings/secrets",
                      params: routeParams,
                      fuzzy: false,
                    })
                  ? "secrets"
                  : matchRoute({
                        to: "/$companyId/company/settings",
                        params: routeParams,
                        fuzzy: false,
                      })
                    ? "general"
                    : null;

  function handleTabChange(value: string) {
    const nextTab = items.find((item) => item.value === value);
    if (!nextTab || nextTab.value === activeTab) return;
    void navigate({ to: nextTab.to, params: { companyId } });
  }

  return (
    <Tabs value={activeTab ?? undefined} onValueChange={handleTabChange}>
      <PageTabBar
        items={items.map(({ value, label }) => ({ value, label }))}
        value={activeTab ?? undefined}
        onValueChange={handleTabChange}
        align="start"
      />
    </Tabs>
  );
}
