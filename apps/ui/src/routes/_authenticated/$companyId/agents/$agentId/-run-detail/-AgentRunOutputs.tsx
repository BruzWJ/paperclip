import {
  Artifact,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
} from "@/components/ai-elements/artifact";
import { FileTree, FileTreeFile, FileTreeFolder } from "@/components/ai-elements/file-tree";
import { Badge } from "@/components/ui/badge";
import { RunFileReferences } from "./-AgentRunToolTrace";
import type { RunOutputReference } from "./-agent-run-detail-model";

interface OutputTreeNode {
  name: string;
  path: string;
  reported: boolean;
  children: OutputTreeNode[];
}

function buildOutputTree(paths: readonly string[]): OutputTreeNode[] {
  const root: OutputTreeNode = { name: "", path: "", reported: false, children: [] };
  for (const originalPath of paths) {
    if (!originalPath) continue;
    const absolute = originalPath.startsWith("/");
    const parts = originalPath.split("/").filter(Boolean);
    let parent = root;
    let currentPath = "";

    if (absolute) {
      let absoluteRoot = parent.children.find((candidate) => candidate.path === "/");
      if (!absoluteRoot) {
        absoluteRoot = { name: "/", path: "/", reported: parts.length === 0, children: [] };
        parent.children.push(absoluteRoot);
      } else if (parts.length === 0) {
        absoluteRoot.reported = true;
      }
      parent = absoluteRoot;
      currentPath = "/";
    }

    for (const [index, name] of parts.entries()) {
      const path = currentPath === "/" ? `/${name}` : currentPath ? `${currentPath}/${name}` : name;
      let node = parent.children.find((candidate) => candidate.path === path);
      if (!node) {
        node = { name, path, reported: false, children: [] };
        parent.children.push(node);
      }
      if (index === parts.length - 1) node.reported = true;
      parent = node;
      currentPath = path;
    }
  }
  const sortNodes = (nodes: OutputTreeNode[]) => {
    nodes.sort(
      (left, right) =>
        Number(left.children.length === 0) - Number(right.children.length === 0) ||
        left.name.localeCompare(right.name),
    );
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(root.children);
  return root.children;
}

function TreeNodes({ nodes }: { nodes: readonly OutputTreeNode[] }) {
  return nodes.map((node) =>
    node.children.length === 0 ? (
      <FileTreeFile key={node.path} path={node.path} name={node.name} title={node.path} />
    ) : (
      <FileTreeFolder
        key={node.path}
        path={node.path}
        name={node.reported ? `${node.name} · reported` : node.name}
        title={node.reported ? `Reported workspace path: ${node.path}` : node.path}
      >
        <TreeNodes nodes={node.children} />
      </FileTreeFolder>
    ),
  );
}

function expandedFolders(nodes: readonly OutputTreeNode[]): Set<string> {
  const result = new Set<string>();
  const visit = (items: readonly OutputTreeNode[]) => {
    for (const item of items) {
      if (item.children.length === 0) continue;
      result.add(item.path);
      visit(item.children);
    }
  };
  visit(nodes);
  return result;
}

export function AgentRunOutputs({
  outputs,
  partial = false,
}: {
  outputs: readonly RunOutputReference[];
  partial?: boolean;
}) {
  if (outputs.length === 0 && !partial) return null;
  const workspacePaths = outputs
    .filter((output) => output.kind === "workspace_path")
    .map((output) => output.value);
  const fileReferences = outputs.filter((output) => output.kind === "file_reference");
  const tree = buildOutputTree(workspacePaths);
  return (
    <Artifact>
      <ArtifactHeader>
        <div className="min-w-0">
          <ArtifactTitle>Loaded output references</ArtifactTitle>
          <ArtifactDescription>
            {outputs.length} loaded reference{outputs.length === 1 ? "" : "s"} reported by canonical tool or
            snapshot data{partial ? "; more may be available" : ""}
          </ArtifactDescription>
        </div>
        {partial ? (
          <Badge variant="outline" className="shrink-0">
            Partial
          </Badge>
        ) : null}
      </ArtifactHeader>
      <ArtifactContent className="space-y-4">
        {outputs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No output references appear in the loaded messages.</p>
        ) : null}
        {workspacePaths.length ? (
          <div className="space-y-2">
            <p className="font-medium text-xs text-muted-foreground">Workspace paths</p>
            <FileTree
              defaultExpanded={expandedFolders(tree)}
              role="group"
              aria-label="Reported workspace output paths"
            >
              <TreeNodes nodes={tree} />
            </FileTree>
          </div>
        ) : null}
        {fileReferences.length ? (
          <RunFileReferences
            label="File references"
            files={fileReferences.map((file) => ({
              id: file.value,
              uri: file.value,
              mime: file.mediaType,
              name: file.name,
            }))}
          />
        ) : null}
        <p className="mt-3 text-xs text-muted-foreground">
          These are loaded provider-reported execution outputs, not published Paperclip artifacts or download
          links.{partial ? " Load the remaining transcript to discover later references." : ""}
        </p>
      </ArtifactContent>
    </Artifact>
  );
}
