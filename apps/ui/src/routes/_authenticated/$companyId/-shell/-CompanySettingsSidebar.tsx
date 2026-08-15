// Empty collections render dedicated UI when data.length === 0.
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
import { SidebarNavItem } from "./-SidebarNavItem";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";

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
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
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
    <>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="sm">
              <Link
                to="/$companyId/dashboard"
                params={{ companyId }}
                onClick={() => {
                  if (isMobile) setSidebarOpen(false);
                }}
                className="text-muted-foreground"
              >
                <ChevronLeft  data-icon="inline-start"/>
                <span>{selectedCompany?.name ?? "Company"}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="flex items-center gap-2 px-2 py-1">
          <Settings className="h-4 w-4 text-muted-foreground shrink-0"  data-icon="inline-start"/>
          <span className="flex-1 truncate text-sm font-bold text-foreground">Company Settings</span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <nav aria-label="Company settings">
          <SidebarGroup>
            <SidebarGroupLabel>Company settings</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
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
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Instance settings</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
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
                  <SidebarMenuSub>
                    {sidebarPlugins.map((plugin) => (
                      <SidebarMenuSubItem key={plugin.id}>
                        <SidebarMenuSubButton asChild size="sm">
                          <Link
                            to="/$companyId/company/settings/instance/plugins/$pluginId"
                            params={{ companyId, pluginId: plugin.id }}
                            state={SIDEBAR_SCROLL_RESET_STATE}
                            activeProps={{
                              className: "bg-accent text-foreground",
                            }}
                          >
                            {plugin.manifestJson.displayName}
                          </Link>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                ) : null}
                <SidebarNavItem
                  linkOptions={{
                    to: "/$companyId/company/settings/instance/adapters",
                    params: { companyId },
                  }}
                  label="Adapters"
                  icon={Cpu}
                />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
      </SidebarContent>
    </>
  );
}
