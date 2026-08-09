import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileText, FolderOpen, Settings, Users } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Minimal coverage stories for the shared primitives in apps/ui/src/components/ui/
 * that no existing story renders directly (or that existing stories only
 * reach behind a user interaction). Each story renders the primitive in a
 * static, deterministic state so the visual snapshot suite baselines it.
 */
const meta = {
  title: "Foundations/Primitive Coverage",
  parameters: {
    docs: {
      description: {
        component:
          "Static snapshot coverage for shared apps/ui/ primitives not exercised by existing stories: alert-dialog, avatar, breadcrumb, collapsible, command, dropdown-menu, radio-card, scroll-area, sheet, skeleton.",
      },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function StoryFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner">
        <section className="paperclip-story__frame p-6">{children}</section>
      </main>
    </div>
  );
}

export const AvatarStates: Story = {
  render: () => (
    <StoryFrame>
      <div className="flex items-center gap-6">
        <Avatar>
          <AvatarFallback>BO</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>
            <Users />
          </AvatarFallback>
        </Avatar>
        <AvatarGroup>
          <Avatar>
            <AvatarFallback>PL</AvatarFallback>
          </Avatar>
          <Avatar>
            <AvatarFallback>QA</AvatarFallback>
          </Avatar>
          <AvatarGroupCount>+3</AvatarGroupCount>
        </AvatarGroup>
      </div>
    </StoryFrame>
  ),
};

export const BreadcrumbTrail: Story = {
  render: () => (
    <StoryFrame>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="#">Paperclip</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbEllipsis />
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink href="#">Projects</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Control plane</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    </StoryFrame>
  ),
};

export const CollapsibleOpenClosed: Story = {
  render: () => (
    <StoryFrame>
      <div className="space-y-6">
        <Collapsible open className="rounded-md border border-border p-3">
          <CollapsibleTrigger className="text-sm font-medium">
            Open section
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2 text-sm text-muted-foreground">
            Visible collapsible content used for snapshot coverage.
          </CollapsibleContent>
        </Collapsible>
        <Collapsible className="rounded-md border border-border p-3">
          <CollapsibleTrigger className="text-sm font-medium">
            Closed section
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2 text-sm text-muted-foreground">
            Hidden content.
          </CollapsibleContent>
        </Collapsible>
      </div>
    </StoryFrame>
  ),
};

export const CommandPaletteInline: Story = {
  render: () => (
    <StoryFrame>
      <Command className="max-w-md rounded-lg border border-border shadow-md">
        <CommandInput placeholder="Type a command or search…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Navigate">
            <CommandItem>
              <FolderOpen />
              <span>Open project</span>
              <CommandShortcut>⌘O</CommandShortcut>
            </CommandItem>
            <CommandItem>
              <FileText />
              <span>View tasks</span>
              <CommandShortcut>⌘T</CommandShortcut>
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Settings">
            <CommandItem>
              <Settings />
              <span>Instance settings</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </StoryFrame>
  ),
};

export const RadioCards: Story = {
  render: () => (
    <StoryFrame>
      <div className="max-w-md space-y-6">
        <RadioGroup
          aria-label="Delivery mode"
          value="draft"
          onValueChange={() => {}}
          className="gap-2"
        >
          {[
            {
              value: "draft",
              title: "Draft for review",
              description: "The agent proposes; you approve before it ships.",
            },
            {
              value: "auto",
              title: "Deliver automatically",
              description: "Finished work is delivered without a review gate.",
            },
          ].map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer flex-col items-start gap-1 rounded-md border px-4 py-3 transition-colors ${
                option.value === "draft"
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border hover:border-border hover:bg-accent/40"
              }`}
            >
              <div className="flex w-full items-center justify-between gap-2">
                <span className="text-sm font-medium">{option.title}</span>
                <RadioGroupItem value={option.value} id={option.value} />
              </div>
              {option.description && (
                <span className="text-xs text-muted-foreground">{option.description}</span>
              )}
            </label>
          ))}
        </RadioGroup>
        <label className="flex cursor-pointer flex-col items-start gap-1 rounded-md border border-border px-4 py-3 transition-colors hover:border-border hover:bg-accent/40">
          <div className="flex w-full items-center justify-between gap-2">
            <span className="text-sm font-medium">Standalone card</span>
            <RadioGroupItem value="standalone" id="standalone" />
          </div>
          <span className="text-xs text-muted-foreground">Unselected state.</span>
        </label>
      </div>
    </StoryFrame>
  ),
};

export const ScrollAreaList: Story = {
  render: () => (
    <StoryFrame>
      <ScrollArea className="h-40 w-64 rounded-md border border-border">
        <div className="p-3">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="py-1.5 text-sm">
              Execution run #{1200 + i}
            </div>
          ))}
        </div>
      </ScrollArea>
    </StoryFrame>
  ),
};

export const SkeletonLoading: Story = {
  render: () => (
    <StoryFrame>
      <div className="max-w-sm space-y-3">
        <Skeleton className="h-10 w-10 rounded-full" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-24 w-full" />
      </div>
    </StoryFrame>
  ),
};

export const AlertDialogOpen: Story = {
  render: () => (
    <StoryFrame>
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this run?</AlertDialogTitle>
            <AlertDialogDescription>
              The agent will stop immediately and the task returns to the queue.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep running</AlertDialogCancel>
            <AlertDialogAction>Cancel run</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </StoryFrame>
  ),
};

export const DropdownMenuOpen: Story = {
  render: () => (
    <StoryFrame>
      <div className="flex min-h-72 items-start">
        <DropdownMenu open>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">Task actions</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuItem>Assign agent</DropdownMenuItem>
            <DropdownMenuItem>Move to project</DropdownMenuItem>
            <DropdownMenuCheckboxItem checked>Watch updates</DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive">Delete task</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </StoryFrame>
  ),
};

export const SheetOpen: Story = {
  render: () => (
    <StoryFrame>
      <Sheet open>
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>Run details</SheetTitle>
            <SheetDescription>Inspect the run without leaving the board.</SheetDescription>
          </SheetHeader>
          <div className="px-4 text-sm text-muted-foreground">
            Sheet body content for snapshot coverage.
          </div>
          <SheetFooter>
            <Button>Done</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </StoryFrame>
  ),
};
