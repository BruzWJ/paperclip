import { useEffect, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";

import { useBreadcrumbs } from "@/context/BreadcrumbContext";

export function useSettingsBreadcrumbs({
  companyId,
  page,
  instance = false,
  parent,
  enabled = true,
}: {
  companyId: string;
  page: string;
  instance?: boolean;
  parent?: "plugins";
  enabled?: boolean;
}) {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    if (!enabled) return;
    setBreadcrumbs([
      {
        label: "Settings",
        renderLink: (content) => (
          <Link to="/$companyId/company/settings" params={{ companyId }}>
            {content}
          </Link>
        ),
      },
      ...(instance
        ? [
            {
              label: "Instance settings",
              renderLink: (content: ReactNode) => (
                <Link to="/$companyId/company/settings/instance" params={{ companyId }}>
                  {content}
                </Link>
              ),
            },
          ]
        : []),
      ...(parent === "plugins"
        ? [
            {
              label: "Plugins",
              renderLink: (content: ReactNode) => (
                <Link to="/$companyId/company/settings/instance/plugins" params={{ companyId }}>
                  {content}
                </Link>
              ),
            },
          ]
        : []),
      { label: page },
    ]);
  }, [companyId, enabled, instance, page, parent, setBreadcrumbs]);
}
