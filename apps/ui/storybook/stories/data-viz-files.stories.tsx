import { useEffect, useMemo, useState } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";

import { Bot, CheckCircle2, FileCode2, FolderKanban, ShieldCheck } from "lucide-react";

import {
  buildFileTree,
  collectAllPaths,
  countFiles,
  FileTree,
  parseFrontmatter,
  type FileTreeNode,
} from "@/components/FileTree";

import { Badge } from "@/components/ui/badge";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { DomainStatus } from "@/components/patterns/DomainStatus";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StorySection as Section, StoryShell } from "./story-layout";

const packageFiles: Record<string, string> = {
  "COMPANY.md": "---\nname: Paperclip Storybook\nkind: company\n---\nFixture company package for UI review.",
  "agents/codexcoder/AGENTS.md": "---\nname: CodexCoder\n---\nShips product UI and verifies changes.",
  "agents/qachecker/AGENTS.md":
    "---\nname: QAChecker\n---\nReviews browser behavior and acceptance criteria.",
  "projects/board-ui/PROJECT.md":
    "---\ntitle: Board UI\nstatus: in_progress\n---\nStorybook and operator control-plane surfaces.",
  "tasks/PAP-1641.md":
    "---\ntitle: Create super-detailed storybooks\npriority: high\n---\nParent task for Storybook coverage.",
  "tasks/PAP-1677.md":
    "---\ntitle: Data Visualization & Misc stories\npriority: medium\n---\nFixture task for this story file.",
};

const actionMap = new Map([
  ["COMPANY.md", "replace"],
  ["agents/codexcoder/AGENTS.md", "update"],
  ["agents/qachecker/AGENTS.md", "create"],
  ["tasks/PAP-1677.md", "create"],
]);

function FileTreeDemo({ empty = false }: { empty?: boolean }) {
  const nodes = useMemo(() => (empty ? [] : buildFileTree(packageFiles, actionMap)), [empty]);
  const allFilePaths = useMemo(() => collectAllPaths(nodes, "file"), [nodes]);
  const [expandedDirs, setExpandedDirs] = useState(() => collectAllPaths(nodes, "dir"));
  const [checkedFiles, setCheckedFiles] = useState(() => allFilePaths);
  const [selectedFile, setSelectedFile] = useState<string | null>(empty ? null : "tasks/PAP-1677.md");

  useEffect(() => {
    setExpandedDirs(collectAllPaths(nodes, "dir"));
    setCheckedFiles(allFilePaths);
    setSelectedFile(empty ? null : "tasks/PAP-1677.md");
  }, [allFilePaths, empty, nodes]);

  const selectedContent = selectedFile ? (packageFiles[selectedFile] ?? "") : "";
  const frontmatter = selectedContent ? parseFrontmatter(selectedContent) : null;

  function toggleDir(path: string) {
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleCheck(path: string, kind: "file" | "dir") {
    setCheckedFiles((current) => {
      const next = new Set(current);
      const paths =
        kind === "file" ? [path] : [...collectAllPaths(findNode(nodes, path)?.children ?? [], "file")];
      const shouldCheck = paths.some((candidate) => !next.has(candidate));
      for (const candidate of paths) {
        if (shouldCheck) next.add(candidate);
        else next.delete(candidate);
      }
      return next;
    });
  }

  return (
    <StoryShell>
      <Section eyebrow="FileTree" title={empty ? "Empty package export" : "Selectable company package tree"}>
        {empty ? (
          <div className="rounded-lg border border-dashed border-border bg-background/70 p-6 text-sm text-muted-foreground">
            No files are included in this package preview.
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.1fr)]">
            <div className="overflow-hidden rounded-lg border border-border bg-background/70">
              <div className="flex items-center justify-between border-b border-border px-4 py-3 text-sm">
                <span className="font-medium">Package contents</span>
                <Badge variant="outline">{countFiles(nodes)} files</Badge>
              </div>
              <FileTree
                nodes={nodes}
                selectedFile={selectedFile}
                expandedDirs={expandedDirs}
                checkedFiles={checkedFiles}
                onToggleDir={toggleDir}
                onSelectFile={setSelectedFile}
                onToggleCheck={toggleCheck}
                renderFileExtra={(node) =>
                  node.action ? (
                    <Badge variant="secondary" className="ml-auto text-[10px]">
                      {node.action}
                    </Badge>
                  ) : null
                }
              />
            </div>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileCode2 className="h-4 w-4" />
                  {selectedFile}
                </CardTitle>
                <CardDescription>
                  Frontmatter and markdown body parsed from the selected package file.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {frontmatter ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {Object.entries(frontmatter.data).map(([key, value]) => (
                      <div key={key} className="rounded-md border border-border bg-background/70 p-2">
                        <div className="text-[10px] uppercase text-muted-foreground">{key}</div>
                        <div className="mt-1 text-sm">{Array.isArray(value) ? value.join(", ") : value}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
                <pre className="max-h-56 overflow-auto rounded-md bg-muted/40 p-3 text-xs leading-5">
                  {frontmatter?.body.trim() || selectedContent}
                </pre>
              </CardContent>
            </Card>
          </div>
        )}
      </Section>
    </StoryShell>
  );
}

function findNode(nodes: FileTreeNode[], path: string): FileTreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    const child = findNode(node.children, path);
    if (child) return child;
  }
  return null;
}

function EntityRowsDemo({ empty = false }: { empty?: boolean }) {
  const rows = empty
    ? []
    : [
        {
          id: "agent",
          leading: <Bot className="h-4 w-4 text-cyan-600" />,
          identifier: "agent",
          title: "CodexCoder",
          subtitle: "Senior Product Engineer · active in Storybook preview",
          trailing: <DomainStatus status="running" />,
          selected: true,
        },
        {
          id: "task",
          leading: <FolderKanban className="h-4 w-4 text-emerald-600" />,
          identifier: "PAP-1677",
          title: "Storybook: Data Visualization & Misc stories",
          subtitle: "Medium priority · Board UI project",
          trailing: <Badge variant="secondary">UI</Badge>,
        },
        {
          id: "approval",
          leading: <ShieldCheck className="h-4 w-4 text-amber-600" />,
          identifier: "approval",
          title: "Publish Storybook preview",
          subtitle: "Approved for internal design review",
          trailing: <CheckCircle2 className="h-4 w-4 text-emerald-600" />,
        },
      ];

  return (
    <StoryShell>
      <Section eyebrow="EntityRow" title={empty ? "Empty list container" : "Generic list rows"}>
        <div className="overflow-hidden rounded-lg border border-border bg-background/70">
          {rows.map((row) => (
            <Item key={row.id} variant={row.selected ? "muted" : "default"}>
              <ItemMedia variant="icon">{row.leading}</ItemMedia>
              <ItemContent>
                <ItemTitle>
                  <span className="font-mono text-xs text-muted-foreground">{row.identifier}</span>
                  {row.title}
                </ItemTitle>
                <ItemDescription>{row.subtitle}</ItemDescription>
              </ItemContent>
              <ItemActions>{row.trailing}</ItemActions>
            </Item>
          ))}
          {rows.length === 0 && (
            <div className="p-6 text-sm text-muted-foreground">No entities match this view.</div>
          )}
        </div>
      </Section>
    </StoryShell>
  );
}

const meta = {
  title: "Product/Data Visualization & Misc",
  parameters: {
    docs: {
      description: {
        component:
          "Fixture-backed stories for charting, board, filtering, live run, onboarding, package preview, entity row, mobile gesture, generated icon, ASCII animation, and skeleton states.",
      },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const FileTreePopulated: Story = {
  name: "FileTree / Populated",
  render: () => <FileTreeDemo />,
};

export const FileTreeEmpty: Story = {
  name: "FileTree / Empty",
  render: () => <FileTreeDemo empty />,
};

export const EntityRowPopulated: Story = {
  name: "EntityRow / Populated",
  render: () => <EntityRowsDemo />,
};

export const EntityRowEmpty: Story = {
  name: "EntityRow / Empty",
  render: () => <EntityRowsDemo empty />,
};
