import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Bot, CircleDot, House, Inbox, LayoutDashboard, SquarePen, Users } from "lucide-react";
import { BreadcrumbBar } from "@/routes/_authenticated/$companyId/-shell/-BreadcrumbBar";
import { CommandPalette } from "@/routes/_authenticated/$companyId/-shell/-CommandPalette";
import { KeyboardShortcutsCheatsheetContent } from "@/routes/_authenticated/$companyId/-shell/-KeyboardShortcutsCheatsheet";
import { MobileBottomNav } from "@/routes/_authenticated/$companyId/-shell/-LayoutView";
import { Sidebar } from "@/routes/_authenticated/$companyId/-shell/-Sidebar";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { SidebarAccountMenu } from "@/routes/_authenticated/$companyId/-shell/-SidebarAccountMenu";
import { SidebarCompanyMenu } from "@/routes/_authenticated/$companyId/-shell/-SidebarCompanyMenu";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BreadcrumbProvider, useBreadcrumbs, type Breadcrumb } from "@/context/BreadcrumbContext";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import {
  storybookAgents,
  storybookTasks,
  storybookProjects,
  storybookSidebarBadges,
} from "../fixtures/paperclipData";
import { StorySection as Section } from "./story-layout";

function ProjectTasksRouteSetter() {
  const navigate = useNavigate();

  useEffect(() => {
    void navigate({
      to: "/$companyId/projects/$projectId/tasks",
      params: {
        companyId: "11111111-1111-4111-8111-111111111111",
        projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      },
      replace: true,
    });
  }, [navigate]);

  return null;
}

function SidebarShell({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div className="h-[520px] overflow-hidden border border-border bg-background">
      <div className="flex h-full min-h-0">
        <div className={cn("overflow-hidden transition-[width]", collapsed ? "w-0" : "w-60")}>
          <Sidebar />
        </div>
      </div>
    </div>
  );
}

function BreadcrumbScenario({ breadcrumbs }: { breadcrumbs: Breadcrumb[] }) {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs(breadcrumbs);
  }, [breadcrumbs, setBreadcrumbs]);

  return (
    <div className="overflow-hidden border border-border bg-background">
      <BreadcrumbBar />
    </div>
  );
}

function BreadcrumbSnapshot({ breadcrumbs }: { breadcrumbs: Breadcrumb[] }) {
  return (
    <BreadcrumbProvider>
      <BreadcrumbScenario breadcrumbs={breadcrumbs} />
    </BreadcrumbProvider>
  );
}

const tabItems = [
  { value: "overview", label: "Overview" },
  { value: "tasks", label: "Tasks" },
  { value: "runs", label: "Runs" },
  { value: "approvals", label: "Approvals" },
  { value: "budget", label: "Budget" },
  { value: "activity", label: "Activity" },
  { value: "settings", label: "Settings" },
  { value: "history", label: "History" },
];

const mobileNavItems = [
  { label: "Home", icon: House },
  { label: "Tasks", icon: CircleDot },
  { label: "Create", icon: SquarePen },
  { label: "Agents", icon: Users },
  { label: "Inbox", icon: Inbox, badge: storybookSidebarBadges.inbox },
];

function MobileBottomNavActiveStateMatrix() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {mobileNavItems.map((activeItem) => (
        <div key={activeItem.label} className="overflow-hidden border border-border bg-background">
          <div className="grid h-16 grid-cols-5 px-1">
            {mobileNavItems.map((item) => {
              const Icon = item.icon;
              const active = item.label === activeItem.label;
              return (
                <div
                  key={item.label}
                  className={cn(
                    "relative flex min-w-0 flex-col items-center justify-center gap-1 rounded-md text-[10px] font-medium",
                    active ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  <span className="relative">
                    <Icon className={cn("h-[18px] w-[18px]", active && "stroke-[2.3]")} />
                    {item.badge ? (
                      <span className="absolute -right-2 -top-2 rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-none text-primary-foreground">
                        {item.badge}
                      </span>
                    ) : null}
                  </span>
                  <span className="truncate">{item.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function CommandResultsSurface() {
  return (
    <Command className="rounded-none border border-border">
      <CommandInput value="story" readOnly placeholder="Search tasks, agents, projects..." />
      <CommandList className="max-h-none">
        <CommandGroup heading="Actions">
          <CommandItem>
            <SquarePen className="mr-2 h-4 w-4" />
            Create new task
            <span className="ml-auto text-xs text-muted-foreground">C</span>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Tasks">
          {storybookTasks.slice(0, 2).map((task) => (
            <CommandItem key={task.id}>
              <CircleDot className="mr-2 h-4 w-4" />
              <span className="mr-2 font-mono text-xs text-muted-foreground">{task.identifier}</span>
              <span className="flex-1 truncate">{task.title}</span>
              <DomainStatus status={task.boardPresentationStatus} />
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Agents">
          {storybookAgents.map((agent) => (
            <CommandItem key={agent.id}>
              <Bot className="mr-2 h-4 w-4" />
              {agent.name}
              {agent.title ? <span className="ml-2 text-xs text-muted-foreground">{agent.title}</span> : null}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Projects">
          {storybookProjects.map((project) => (
            <CommandItem key={project.id}>
              <LayoutDashboard className="mr-2 h-4 w-4" />
              {project.name}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

function CommandEmptySurface() {
  return (
    <Command className="rounded-none border border-border">
      <CommandInput value="no matching command" readOnly placeholder="Search tasks, agents, projects..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
      </CommandList>
    </Command>
  );
}

function NavigationLayoutStories() {
  return (
    <div className="paperclip-story">
      <ProjectTasksRouteSetter />
      <main className="paperclip-story__inner max-w-[1320px] space-y-6">
        <section className="paperclip-story__frame p-6">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div>
              <div className="paperclip-story__label">Navigation and layout</div>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight">
                Sidebar, command, tabs, and mobile chrome
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
                Fixture-backed navigation states for the board shell: company switching, dense work
                navigation, breadcrumbs, command discovery, and mobile entry points.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">fixture backed</Badge>
              <Badge variant="outline">company scoped</Badge>
              <Badge variant="outline">responsive chrome</Badge>
            </div>
          </div>
        </section>

        <Section eyebrow="Sidebar" title="Expanded and collapsed shell states">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_220px]">
            <SidebarShell />
            <SidebarShell collapsed />
          </div>
        </Section>

        <Section eyebrow="Menus" title="Account and company menus in open state">
          <div className="grid gap-5 xl:grid-cols-2">
            <div className="relative h-[440px] overflow-hidden border border-border bg-background">
              <div className="absolute bottom-0 left-0 w-72">
                <SidebarAccountMenu open onOpenChange={() => undefined} />
              </div>
            </div>

            <div className="h-[260px] overflow-hidden border border-border bg-background p-3">
              <SidebarCompanyMenu open onOpenChange={() => undefined} />
            </div>
          </div>
        </Section>

        <Section eyebrow="Breadcrumbs" title="Home, project task, and agent run depth levels">
          <div className="grid gap-4">
            <BreadcrumbSnapshot breadcrumbs={[{ label: "Dashboard" }]} />
            <BreadcrumbSnapshot
              breadcrumbs={[
                {
                  label: "Projects",
                  renderLink: (content) => (
                    <Link
                      to="/$companyId/projects"
                      params={{
                        companyId: "11111111-1111-4111-8111-111111111111",
                      }}
                    >
                      {content}
                    </Link>
                  ),
                },
                {
                  label: "Board UI",
                  renderLink: (content) => (
                    <Link
                      to="/$companyId/projects/$projectId/tasks"
                      params={{
                        companyId: "11111111-1111-4111-8111-111111111111",
                        projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
                      }}
                    >
                      {content}
                    </Link>
                  ),
                },
                { label: "PAP-1641" },
              ]}
            />
            <BreadcrumbSnapshot
              breadcrumbs={[
                {
                  label: "Agents",
                  renderLink: (content) => (
                    <Link
                      to="/$companyId/agents"
                      params={{
                        companyId: "11111111-1111-4111-8111-111111111111",
                      }}
                    >
                      {content}
                    </Link>
                  ),
                },
                {
                  label: "CodexCoder",
                  renderLink: (content) => (
                    <Link
                      to="/$companyId/agents/$agentId"
                      params={{
                        companyId: "11111111-1111-4111-8111-111111111111",
                        agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
                      }}
                    >
                      {content}
                    </Link>
                  ),
                },
                { label: "Run 90000000-0000-4000-8000-000000000001" },
              ]}
            />
          </div>
        </Section>

        <Section eyebrow="Page tabs" title="Active and overflow tab bars">
          <div className="space-y-5">
            <Tabs value="tasks" className="overflow-x-auto">
              <TabsList variant="line" className="justify-start">
                {tabItems.slice(0, 4).map((item) => (
                  <TabsTrigger key={item.value} value={item.value}>
                    {item.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Tabs value="activity" className="overflow-x-auto">
              <TabsList variant="line" className="justify-start">
                {tabItems.map((item) => (
                  <TabsTrigger key={item.value} value={item.value}>
                    {item.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
        </Section>

        <Section eyebrow="Mobile bottom nav" title="Actual mobile bar and all active item states">
          <div className="space-y-5">
            <div className="relative h-24 max-w-sm overflow-hidden border border-border bg-background [&>nav]:!absolute [&>nav]:!bottom-0 [&>nav]:!left-0 [&>nav]:!right-0 [&>nav]:!z-0 [&>nav]:!block">
              <MobileBottomNav visible companyId="11111111-1111-4111-8111-111111111111" />
            </div>
            <MobileBottomNavActiveStateMatrix />
          </div>
        </Section>

        <Section eyebrow="Command palette" title="Open command results and empty state">
          <CommandPalette />
          <div className="grid gap-5 xl:grid-cols-2">
            <CommandResultsSurface />
            <CommandEmptySurface />
          </div>
        </Section>

        <Section eyebrow="Keyboard shortcuts" title="Rendered shortcuts cheatsheet">
          <div className="max-w-md overflow-hidden border border-border bg-background">
            <div className="px-5 pb-3 pt-5">
              <h3 className="text-base font-semibold">Keyboard shortcuts</h3>
            </div>
            <KeyboardShortcutsCheatsheetContent />
          </div>
        </Section>
      </main>
    </div>
  );
}

const meta = {
  title: "Product/Navigation & Layout",
  component: NavigationLayoutStories,
  // Sidebar mounts PluginLauncherOutlet unconditionally once a company is
  // selected; without this provider the story raced company selection and
  // intermittently threw "usePluginLauncherRuntime must be used within
  // PluginLauncherProvider".
  decorators: [
    (Story) => (
      <PluginLauncherProvider>
        <Story />
      </PluginLauncherProvider>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "Navigation and layout stories cover the board shell components that orient operators across companies, work surfaces, command search, breadcrumbs, tabs, and mobile navigation.",
      },
    },
  },
} satisfies Meta<typeof NavigationLayoutStories>;

export default meta;

type Story = StoryObj<typeof meta>;

export const BoardChromeMatrix: Story = {};

// PAP-10676 verification harness: renders the real Sidebar at a fixed width so a
// screenshot of the expanded state and a screenshot of the pinned-collapsed rail
// can be overlaid. The icon column must be pixel-identical between the two — the
// only difference should be the labels (sr-only in the rail). Playwright toggles
// collapse via the in-sidebar control, so this exercises the real context path.
function SidebarIconAlignmentHarness() {
  return (
    <PluginLauncherProvider>
      <div className="paperclip-story">
        <ProjectTasksRouteSetter />
        <div className="flex min-h-[760px] items-start justify-center bg-muted/30 p-8">
          <div
            data-testid="sidebar-align-frame"
            className="h-[700px] w-60 overflow-hidden border border-border bg-background"
          >
            <Sidebar />
          </div>
        </div>
      </div>
    </PluginLauncherProvider>
  );
}

export const SidebarIconAlignment: Story = {
  render: () => <SidebarIconAlignmentHarness />,
};
