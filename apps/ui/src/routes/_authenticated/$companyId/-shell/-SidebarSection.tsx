import { useState, type ComponentType, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/context/SidebarContext";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { LabeledValue, OpenStateProps } from "@/lib/presentation-contracts";
import { useSidebarNavExpanded } from "./-SidebarNavItem";
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel } from "@/components/ui/sidebar";

type SidebarSectionIcon = ComponentType<{ className?: string }>;

export type SidebarSectionMenuAction =
  | {
      type: "item";
      label: string;
      icon?: SidebarSectionIcon;
      renderLink?: (content: ReactNode) => ReactNode;
      onSelect?: () => void;
    }
  | { type: "separator" };

type SidebarSectionMenu = {
  actions?: SidebarSectionMenuAction[];
  ariaLabel?: string;
  radioChoices?: LabeledValue[];
  radioLabel?: string;
  radioValue?: string;
  onRadioValueChange?: (value: string) => void;
};

type SidebarSectionHeaderAction = {
  ariaLabel: string;
  icon: SidebarSectionIcon;
  onClick: () => void;
};

interface SidebarSectionProps {
  label: string;
  children: ReactNode;
  collapsible?: OpenStateProps;
  menu?: SidebarSectionMenu;
  headerAction?: SidebarSectionHeaderAction;
}

export const SIDEBAR_GROUP_LAYOUT_CLASSNAME = "p-3 py-2";

function SidebarSectionHeader({
  collapsible,
  headerAction,
  label,
  menu,
}: Pick<SidebarSectionProps, "collapsible" | "headerAction" | "label" | "menu">) {
  const { isMobile } = useSidebar();
  const [menuOpen, setMenuOpen] = useState(false);
  const hasMenu = Boolean(menu && ((menu.actions?.length ?? 0) > 0 || (menu.radioChoices?.length ?? 0) > 0));
  const labelClassName =
    "text-(length:--text-nano) font-medium uppercase tracking-widest font-mono text-muted-foreground/60";
  const headerControlVisibilityClassName = isMobile
    ? "opacity-100"
    : "opacity-0 group-hover/sidebar-section:opacity-100 group-focus-within/sidebar-section:opacity-100";
  const caretClassName = cn(
    "h-3 w-3 shrink-0 text-muted-foreground/60 transition-all",
    headerControlVisibilityClassName,
    collapsible?.open && "rotate-90",
    menuOpen && "opacity-100",
  );
  const actionClassName = cn(
    "h-5 w-5 shrink-0 text-muted-foreground/60 transition-opacity hover:text-foreground data-[state=open]:opacity-100",
    headerControlVisibilityClassName,
  );
  const headerContent = <span className={labelClassName}>{label}</span>;
  const HeaderActionIcon = headerAction?.icon;

  const headingControl = hasMenu ? (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-auto min-w-0 max-w-full px-1 py-0.5"
          aria-label={menu?.ariaLabel ?? `${label} actions`}
        >
          {headerContent}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {menu?.actions?.map((action, index) => {
          if (action.type === "separator") {
            return <DropdownMenuSeparator key={`separator-${index}`} />;
          }
          const Icon = action.icon;
          const content = (
            <>
              {Icon ? <Icon className="size-4" /> : null}
              <span>{action.label}</span>
            </>
          );
          if (action.renderLink) {
            return (
              <DropdownMenuItem key={`${action.label}-${index}`} asChild>
                {action.renderLink(content)}
              </DropdownMenuItem>
            );
          }
          return (
            <DropdownMenuItem key={`${action.label}-${index}`} onSelect={action.onSelect}>
              {content}
            </DropdownMenuItem>
          );
        })}
        {menu?.radioChoices && menu.radioChoices.length > 0 ? (
          <DropdownMenuRadioGroup
            value={menu.radioValue}
            onValueChange={menu.onRadioValueChange}
            aria-label={menu.radioLabel}
          >
            {menu.radioChoices.map((choice) => (
              <DropdownMenuRadioItem key={choice.value} value={choice.value}>
                {choice.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : (
    headerContent
  );

  return (
    <SidebarGroupLabel className="group/sidebar-section gap-1">
      {collapsible ? (
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={collapsible.open ? `Collapse ${label}` : `Expand ${label}`}
          >
            <ChevronRight className={caretClassName} aria-hidden="true"  data-icon="inline-start"/>
          </Button>
        </CollapsibleTrigger>
      ) : null}
      {headingControl}
      {headerAction && HeaderActionIcon ? (
        <Button
          variant="ghost"
          size="icon-xs"
          className={actionClassName}
          aria-label={headerAction.ariaLabel}
          onClick={headerAction.onClick}
        >
          <HeaderActionIcon className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </SidebarGroupLabel>
  );
}

export function SidebarSection({ label, children, collapsible, menu, headerAction }: SidebarSectionProps) {
  const { collapsed, peeking } = useSidebar();
  const forceExpanded = useSidebarNavExpanded();
  const rail = collapsed && !peeking && !forceExpanded;
  const content = <SidebarGroupContent className="flex flex-col gap-0.5">{children}</SidebarGroupContent>;

  // Keep the expanded header's exact footprint in the rail so every item below
  // it retains the same x/y position when the sidebar changes state.
  if (rail) {
    return (
      <SidebarGroup className={SIDEBAR_GROUP_LAYOUT_CLASSNAME}>
        <SidebarGroupLabel className="group-data-[collapsible=icon]:mt-0">
          <span className="sr-only">{label}</span>
        </SidebarGroupLabel>
        {content}
      </SidebarGroup>
    );
  }

  if (collapsible) {
    return (
      <Collapsible asChild open={collapsible.open} onOpenChange={collapsible.onOpenChange}>
        <SidebarGroup className={SIDEBAR_GROUP_LAYOUT_CLASSNAME}>
          <SidebarSectionHeader
            label={label}
            collapsible={collapsible}
            menu={menu}
            headerAction={headerAction}
          />
          <CollapsibleContent>{content}</CollapsibleContent>
        </SidebarGroup>
      </Collapsible>
    );
  }

  return (
    <SidebarGroup className={SIDEBAR_GROUP_LAYOUT_CLASSNAME}>
      <SidebarSectionHeader label={label} menu={menu} headerAction={headerAction} />
      {content}
    </SidebarGroup>
  );
}
