import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  Cpu,
  KeyRound,
  MailPlus,
  Puzzle,
  Settings,
  Shield,
  SlidersHorizontal,
  UserRoundPen,
  Users,
} from "lucide-react";
import { sidebarBadgesApi } from "@/api/sidebarBadges";
import { pluginsApi } from "@/api/plugins";
import { ApiError } from "@/api/client";
import { Link } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { SIDEBAR_SCROLL_RESET_STATE } from "@/lib/navigation-scroll";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { usePluginSlots } from "@/plugins/slots";
import { SidebarNavItem } from "./SidebarNavItem";

export function CompanySettingsSidebar() {
  const companyId = useCompanyRouteId();
  const { selectedCompany } = useCompany();
  const { isMobile, setSidebarOpen } = useSidebar();
  const { slots: companySettingsPluginSlots } = usePluginSlots({
    slotTypes: ["companySettingsPage"],
    enabled: true,
  });
  const { data: badges } = useQuery({
    queryKey: queryKeys.sidebarBadges(companyId),
    queryFn: async () => {
      try {
        return await sidebarBadgesApi.get(companyId);
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403)
        ) {
          return null;
        }
        throw error;
      }
    },
    retry: false,
  });
  const { data: plugins } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
  });
  const sidebarPlugins = plugins ?? [];

  return (
    <aside className="w-full h-full min-h-0 border-r border-border bg-background flex flex-col">
      <div className="flex flex-col gap-1 px-3 py-3 shrink-0">
        <Link
          to="/$companyId/dashboard"
          params={{ companyId }}
          onClick={() => {
            if (isMobile) setSidebarOpen(false);
          }}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{selectedCompany?.name ?? "Company"}</span>
        </Link>
        <div className="flex items-center gap-2 px-2 py-1">
          <Settings className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="flex-1 truncate text-sm font-bold text-foreground">
            Company Settings
          </span>
        </div>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide px-3 py-2">
        <div className="px-3 pb-1 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
          Company settings
        </div>
        <div className="flex flex-col gap-0.5">
          <SidebarNavItem
            linkOptions={{
              to: "/$companyId/company/settings",
              params: { companyId },
            }}
            label="General"
            icon={SlidersHorizontal}
            end
          />
          <SidebarNavItem
            linkOptions={{
              to: "/$companyId/company/settings/members",
              params: { companyId },
            }}
            label="Members"
            icon={Users}
            badge={badges?.joinRequests ?? 0}
            end
          />
          {companySettingsPluginSlots.map((slot) => {
            const settingsRoutePath = slot.routePath;
            if (!settingsRoutePath) return null;
            return (
              <SidebarNavItem
                key={`${slot.pluginKey}:${slot.id}`}
                linkOptions={{
                  to: "/$companyId/company/settings/$settingsRoutePath",
                  params: {
                    companyId,
                    settingsRoutePath,
                  },
                }}
                label={slot.displayName}
                icon={Puzzle}
                end
              />
            );
          })}
          <SidebarNavItem
            linkOptions={{
              to: "/$companyId/company/settings/invites",
              params: { companyId },
            }}
            label="Invites"
            icon={MailPlus}
            end
          />
          <SidebarNavItem
            linkOptions={{
              to: "/$companyId/company/settings/secrets",
              params: { companyId },
            }}
            label="Secrets"
            icon={KeyRound}
            end
          />
        </div>
        <div className="mt-5 px-3 pb-1 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
          Instance settings
        </div>
        <div className="flex flex-col gap-0.5">
          <SidebarNavItem
            linkOptions={{
              to: "/$companyId/company/settings/instance/profile",
              params: { companyId },
            }}
            label="Profile"
            icon={UserRoundPen}
            end
          />
          <SidebarNavItem
            linkOptions={{
              to: "/$companyId/company/settings/instance",
              params: { companyId },
            }}
            label="General"
            icon={SlidersHorizontal}
            end
          />
          <SidebarNavItem
            linkOptions={{
              to: "/$companyId/company/settings/instance/access",
              params: { companyId },
            }}
            label="Access"
            icon={Shield}
            end
          />
          <SidebarNavItem
            linkOptions={{
              to: "/$companyId/company/settings/instance/plugins",
              params: { companyId },
            }}
            label="Plugins"
            icon={Puzzle}
          />
          {sidebarPlugins.length > 0 ? (
            <div className="ml-4 mt-1 flex flex-col gap-0.5 border-l border-border/70 pl-3">
              {sidebarPlugins.map((plugin) => (
                <Link
                  key={plugin.id}
                  to="/$companyId/company/settings/instance/plugins/$pluginId"
                  params={{ companyId, pluginId: plugin.id }}
                  state={SIDEBAR_SCROLL_RESET_STATE}
                  className="rounded-md px-2 py-1.5 text-xs transition-colors"
                  activeProps={{ className: "bg-accent text-foreground" }}
                  inactiveProps={{
                    className:
                      "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  }}
                >
                  {plugin.manifestJson.displayName}
                </Link>
              ))}
            </div>
          ) : null}
          <SidebarNavItem
            linkOptions={{
              to: "/$companyId/company/settings/instance/adapters",
              params: { companyId },
            }}
            label="Adapters"
            icon={Cpu}
          />
        </div>
      </nav>
    </aside>
  );
}
