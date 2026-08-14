import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { Bot, CircleDot, House, Inbox, Settings2, SquarePen, Users, X } from "lucide-react";
import {
  Suspense,
  useState,
  type Dispatch,
  type FocusEventHandler,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";

import type { DevServerHealthStatus } from "@/api/health";
import { Banner, BannerAction, BannerTitle } from "@/components/kibo-ui/banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { FormDialog } from "@/components/patterns/FormPatterns";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Spinner } from "@/components/ui/spinner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sidebar as ShadcnSidebar } from "@/components/ui/sidebar";
import { GeneralSettingsProvider } from "@/context/GeneralSettingsContext";
import { useDialog, useDialogActions } from "@/context/DialogContext";
import { usePanel } from "@/context/PanelContext";
import { useInboxBadge } from "@/hooks/useInboxBadge";
import { lazyPage } from "@/lib/lazy-page";
import { SIDEBAR_SCROLL_RESET_STATE } from "@/lib/navigation-scroll";
import { cn } from "@/lib/utils";
import { getWorktreeUiBranding } from "@/lib/worktree-branding";
import { CompanySettingsNav } from "./access/CompanySettingsNav";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { CommandPalette } from "./CommandPalette";
import { DevRestartBanner } from "./DevRestartBanner";
import { KeyboardShortcutsCheatsheet } from "./KeyboardShortcutsCheatsheet";
import { RouteErrorBoundary } from "./RouteErrorBoundary";
import { SidebarNavExpandedProvider } from "./SidebarNavItem";
import { Sidebar } from "./Sidebar";
import { SidebarAccountMenu } from "./SidebarAccountMenu";
import { SidebarShell } from "./SidebarShell";
import { StandaloneBrowserControls } from "./StandaloneBrowserControls";

const NewTaskDialog = lazyPage(() => import("./NewTaskDialog"), "NewTaskDialog");
const NewProjectDialog = lazyPage(() => import("./NewProjectDialog"), "NewProjectDialog");
const NewGoalDialog = lazyPage(() => import("./NewGoalDialog"), "NewGoalDialog");

export type LayoutViewProps = {
  keyboardShortcutsEnabled: boolean;
  isMobile: boolean;
  sidebarOpen: boolean;
  collapsed: boolean;
  peeking: boolean;
  hasSecondarySidebar: boolean;
  secondarySidebar: ReactNode;
  isCompanySettingsRoute: boolean;
  hasUnknownCompanyId: boolean;
  companyId: string;
  mainContentRef: RefObject<HTMLElement | null>;
  mobileNavVisible: boolean;
  shortcutsOpen: boolean;
  setShortcutsOpen: Dispatch<SetStateAction<boolean>>;
  devServer?: DevServerHealthStatus;
  onPanelMouseEnter: MouseEventHandler<HTMLDivElement>;
  onPanelMouseLeave: MouseEventHandler<HTMLDivElement>;
  onPanelFocusCapture: FocusEventHandler<HTMLDivElement>;
  onPanelBlurCapture: FocusEventHandler<HTMLDivElement>;
};

function WorktreeBanner() {
  const branding = getWorktreeUiBranding();
  const [copied, setCopied] = useState(false);
  if (!branding) return null;
  return (
    <Banner>
      <BannerTitle>Worktree</BannerTitle>
      <BannerAction
        onClick={() =>
          navigator.clipboard.writeText(branding.name).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? "Copied!" : branding.name}
      </BannerAction>
    </Banner>
  );
}

type MobileNavItem = {
  label: string;
  icon: typeof House;
  badge?: number;
  to?: "/$companyId/dashboard" | "/$companyId/tasks" | "/$companyId/agents" | "/$companyId/inbox";
  onClick?: () => void;
};

export function MobileBottomNav({ visible, companyId }: { visible: boolean; companyId: string }) {
  const { openNewTask } = useDialogActions();
  const inboxBadge = useInboxBadge(companyId);
  const items: MobileNavItem[] = [
    { to: "/$companyId/dashboard", label: "Home", icon: House },
    { to: "/$companyId/tasks", label: "Tasks", icon: CircleDot },
    { label: "Create", icon: SquarePen, onClick: openNewTask },
    { to: "/$companyId/agents", label: "Agents", icon: Users },
    {
      to: "/$companyId/inbox",
      label: "Inbox",
      icon: Inbox,
      badge: inboxBadge.inbox,
    },
  ];

  return (
    <nav
      className={cn(
        "fixed inset-x-0 bottom-0 z-30 grid h-16 grid-cols-5 border-t bg-background p-1 md:hidden",
        !visible && "translate-y-full",
      )}
      aria-label="Mobile navigation"
    >
      {items.map((item) => {
        const Icon = item.icon;
        const content = (
          <>
            <span className="relative">
              <Icon />
              {item.badge ? (
                <Badge className="absolute -right-3 -top-3">{item.badge > 99 ? "99+" : item.badge}</Badge>
              ) : null}
            </span>
            <span>{item.label}</span>
          </>
        );
        return item.onClick ? (
          <Button key={item.label} variant="ghost" className="h-auto flex-col" onClick={item.onClick}>
            {content}
          </Button>
        ) : item.to ? (
          <Button key={item.label} asChild variant="ghost" className="h-auto flex-col">
            <Link
              to={item.to}
              params={{ companyId }}
              state={SIDEBAR_SCROLL_RESET_STATE}
              activeProps={{ className: "bg-accent" }}
            >
              {content}
            </Link>
          </Button>
        ) : null;
      })}
    </nav>
  );
}

/** Presentational application shell shared by the routed layout controller. */
export function LayoutView({
  keyboardShortcutsEnabled,
  isMobile,
  sidebarOpen,
  collapsed,
  peeking,
  hasSecondarySidebar,
  secondarySidebar,
  isCompanySettingsRoute,
  hasUnknownCompanyId,
  companyId,
  mainContentRef,
  mobileNavVisible,
  shortcutsOpen,
  setShortcutsOpen,
  devServer,
  onPanelMouseEnter,
  onPanelMouseLeave,
  onPanelFocusCapture,
  onPanelBlurCapture,
}: LayoutViewProps) {
  const { panelContent, panelVisible, setPanelVisible } = usePanel();
  const { newAgentOpen, closeNewAgent, openNewTask } = useDialog();
  const navigate = useNavigate();
  const showPropertiesPanel = !isMobile && Boolean(panelContent) && panelVisible;

  return (
    <GeneralSettingsProvider value={{ keyboardShortcutsEnabled }}>
      <div
        className={cn(
          "bg-background text-foreground pt-(--sz-safe-top)",
          isMobile ? "min-h-dvh overflow-x-clip" : "flex h-dvh flex-col overflow-clip",
        )}
      >
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-(--z-200) focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Skip to Main Content
        </a>
        <WorktreeBanner />
        <DevRestartBanner devServer={devServer} />
        <div className={cn("min-h-0 flex-1", isMobile ? "w-full" : "flex overflow-clip")}>
          <SidebarShell
            open={sidebarOpen}
            collapsed={collapsed}
            peeking={peeking}
            resizable={!isMobile}
            onPanelMouseEnter={onPanelMouseEnter}
            onPanelMouseLeave={onPanelMouseLeave}
            onPanelFocusCapture={collapsed ? onPanelFocusCapture : undefined}
            onPanelBlurCapture={collapsed ? onPanelBlurCapture : undefined}
          >
            <div className="flex min-h-0 flex-1 flex-col">
              {isMobile && hasSecondarySidebar ? secondarySidebar : <Sidebar />}
            </div>
            <SidebarAccountMenu />
          </SidebarShell>

          {!isMobile && hasSecondarySidebar ? (
            <ShadcnSidebar
              collapsible="none"
              data-secondary-sidebar=""
              className="h-full !w-60 shrink-0 overflow-y-auto border-r border-border"
            >
              <SidebarNavExpandedProvider>{secondarySidebar}</SidebarNavExpandedProvider>
            </ShadcnSidebar>
          ) : null}

          <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "h-full flex-1")}>
            <div
              className={cn(
                isMobile &&
                "sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85",
              )}
            >
              <StandaloneBrowserControls mobile={isMobile} />
              <BreadcrumbBar />
              {isMobile && isCompanySettingsRoute ? (
                <div className="border-b border-border px-4 pb-3">
                  <CompanySettingsNav />
                </div>
              ) : null}
            </div>
            <ResizablePanelGroup
              orientation="horizontal"
              className={cn(isMobile ? "block" : "min-h-0 flex-1")}
            >
              <ResizablePanel defaultSize="75" minSize="45">
                <main
                  id="main-content"
                  ref={mainContentRef}
                  tabIndex={-1}
                  className={cn(
                    "h-full p-4 outline-none md:p-6",
                    isMobile
                      ? "overflow-visible pb-(--sz-calc-14)"
                      : "overflow-auto [scrollbar-gutter:stable]",
                  )}
                >
                  {hasUnknownCompanyId ? (
                    <Empty className="border">
                      <EmptyHeader>
                        <EmptyTitle>Company not found</EmptyTitle>
                        <EmptyDescription>No company matches UUID &quot;{companyId}&quot;.</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ) : (
                    <RouteErrorBoundary>
                      <Suspense
                        fallback={
                          <div
                            className="mx-auto flex max-w-xl items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
                            role="status"
                          >
                            <Spinner />
                            <span className="sr-only">Loading page</span>
                          </div>
                        }
                      >
                        <Outlet />
                      </Suspense>
                    </RouteErrorBoundary>
                  )}
                </main>
              </ResizablePanel>
              {showPropertiesPanel ? (
                <>
                  <ResizableHandle />
                  <ResizablePanel defaultSize="25" minSize={240} maxSize={520}>
                    <Card className="hidden h-full min-h-0 gap-0 rounded-none border-0 py-0 md:flex">
                      <CardHeader className="border-b">
                        <CardTitle>Properties</CardTitle>
                        <CardAction>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => setPanelVisible(false)}
                            aria-label="Close properties panel"
                          >
                            <X />
                          </Button>
                        </CardAction>
                      </CardHeader>
                      <CardContent className="min-h-0 flex-1 p-0">
                        <ScrollArea className="h-full">
                          <div className="p-4">{panelContent}</div>
                        </ScrollArea>
                      </CardContent>
                    </Card>
                  </ResizablePanel>
                </>
              ) : null}
            </ResizablePanelGroup>
          </div>
        </div>
        {isMobile ? <MobileBottomNav visible={mobileNavVisible} companyId={companyId} /> : null}
        <CommandPalette />
        <Suspense fallback={null}>
          <NewTaskDialog />
          <NewProjectDialog />
          <NewGoalDialog />
        </Suspense>
        <FormDialog
          open={newAgentOpen}
          onOpenChange={(open) => !open && closeNewAgent()}
          contentClassName="sm:max-w-md"
          title="Add a new agent"
          description="Ask a leader to propose the hire or configure an ACPX runtime yourself."
          footerClassName="sm:flex-col"
          footer={
            <>
              <Button
                className="w-full"
                onClick={() => {
                  closeNewAgent();
                  openNewTask({
                    title: "Create a new agent",
                    request: "(type in what kind of agent you want here)",
                  });
                }}
              >
                <Bot data-icon="inline-start" />
                Ask an agent to create a new agent
              </Button>
              <Button
                className="w-full"
                variant="outline"
                onClick={() => {
                  closeNewAgent();
                  void navigate({
                    to: "/$companyId/agents/new",
                    params: { companyId },
                  });
                }}
              >
                <Settings2 data-icon="inline-start" />
                Configure an ACPX runtime manually
              </Button>
            </>
          }
        />
        <KeyboardShortcutsCheatsheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      </div>
    </GeneralSettingsProvider>
  );
}
