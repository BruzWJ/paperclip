import {
  Activity as ActivityIcon,
  Circle,
  Clock3,
  History as HistoryIcon,
  KeyRound,
  LayoutGrid,
  Play,
  Send,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { ROUTINE_SECTION_KEYS, type RoutineSectionKey } from "./routine-sections/context";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sidebar as ShadcnSidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";

type NavItem = {
  key: RoutineSectionKey;
  label: string;
  icon: LucideIcon;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Routine",
    items: [
      { key: "overview", label: "Overview", icon: Circle },
      { key: "triggers", label: "Triggers", icon: Clock3 },
      { key: "variables", label: "Variables", icon: LayoutGrid },
      { key: "secrets", label: "Secrets", icon: KeyRound },
      { key: "delivery", label: "Delivery", icon: Send },
    ],
  },
  {
    label: "Operate",
    items: [
      { key: "runs", label: "Runs", icon: Play },
      { key: "activity", label: "Activity", icon: ActivityIcon },
      { key: "history", label: "History", icon: HistoryIcon },
    ],
  },
];

export function RoutineSubSidebar({
  activeSection,
  companyId,
  routineId,
  isSectionDirty,
  hasLiveRun,
}: {
  activeSection: RoutineSectionKey;
  companyId: string;
  routineId: string;
  isSectionDirty: (section: RoutineSectionKey) => boolean;
  hasLiveRun: boolean;
}) {
  return (
    <ShadcnSidebar collapsible="none" className="hidden h-full !w-52 shrink-0 border-r border-border md:flex">
      <SidebarContent>
        <nav aria-label="Routine sections">
          {NAV_GROUPS.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
                    const isActive = item.key === activeSection;
                    const Icon = item.icon;
                    const dirty = isSectionDirty(item.key);
                    const showLiveDot = item.key === "runs" && hasLiveRun;
                    return (
                      <SidebarMenuItem key={item.key}>
                        <SidebarMenuButton asChild isActive={isActive}>
                          <Link
                            to={
                              item.key === "overview"
                                ? "/$companyId/routines/$routineId"
                                : "/$companyId/routines/$routineId/$section"
                            }
                            params={
                              item.key === "overview"
                                ? { companyId, routineId }
                                : { companyId, routineId, section: item.key }
                            }
                            replace
                            aria-current={isActive ? "page" : undefined}
                          >
                            <Icon />
                            <span>{item.label}</span>
                          </Link>
                        </SidebarMenuButton>
                        {showLiveDot || dirty ? (
                          <SidebarMenuBadge aria-label={dirty ? "Unsaved changes" : "Live run"}>
                            {showLiveDot ? (
                              <Spinner className="size-3" aria-hidden="true" />
                            ) : (
                              <Badge variant="secondary" className="size-2 p-0" aria-hidden="true" />
                            )}
                          </SidebarMenuBadge>
                        ) : null}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
    </ShadcnSidebar>
  );
}

/** Mobile section picker — collapses the sub-sidebar into a grouped `<Select>`. */
export function RoutineSectionPicker({
  activeSection,
  onNavigate,
  isSectionDirty,
}: {
  activeSection: RoutineSectionKey;
  onNavigate: (section: RoutineSectionKey) => void;
  isSectionDirty: (section: RoutineSectionKey) => boolean;
}) {
  return (
    <div className="sticky top-0 z-10 border-b border-border bg-background px-4 py-2 md:hidden">
      <Select
        value={activeSection}
        onValueChange={(value) => {
          if (ROUTINE_SECTION_KEYS.includes(value as RoutineSectionKey)) {
            onNavigate(value as RoutineSectionKey);
          }
        }}
      >
        <SelectTrigger className="h-11 w-full" aria-label="Routine section">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {NAV_GROUPS.map((group) => (
            <SelectGroup key={group.label}>
              <SelectLabel className="uppercase tracking-(--tracking-eyebrow) text-(length:--text-micro)">
                {group.label}
              </SelectLabel>
              {group.items.map((item) => (
                <SelectItem key={item.key} value={item.key} className="h-11">
                  <span className="flex items-center gap-2">
                    <item.icon className="h-3.5 w-3.5" />
                    {item.label}
                    {isSectionDirty(item.key) ? (
                      <Badge variant="secondary" className="size-2 p-0" aria-label="Unsaved changes" />
                    ) : null}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
