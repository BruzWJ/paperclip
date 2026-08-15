import { resolvePluginNavigationHref } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import { ExternalLink, Github } from "lucide-react";
import { memo, useMemo } from "react";
import Markdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useOptionalCompany } from "@/context/CompanyContext";
import { useTheme } from "@/context/ThemeContext";
import { mentionChipInlineStyle, parseMentionChipHref } from "@/lib/mention-chips";
import { remarkSoftBreaks } from "@/lib/remark-soft-breaks";
import { parseTaskReferenceFromHref, remarkLinkTaskReferences } from "@/lib/task-reference";
import { cn } from "@/lib/utils";
import { TaskLinkQuicklook } from "../tasks/shared/TaskLinkQuicklook";
import { Table, TableCell, TableHead } from "@/components/ui/table";

import {
  createRemarkWikiLinks,
  extractMermaidSource,
  isExternalHttpUrl,
  isGitHubUrl,
  isNonRouterAnchor,
  mergeTableCellStyle,
  mergeWrapStyle,
  remarkDropHtmlComments,
  safeMarkdownUrlTransform,
} from "./MarkdownTransforms";

import { MermaidDiagramBlock } from "./MermaidDiagramBlock";

import { MarkdownCodeBlock } from "./MarkdownCodeBlock";

import {
  MarkdownAgentMentionLink,
  MarkdownProjectMentionLink,
  MarkdownTaskLink,
  renderLinkBody,
} from "./MarkdownEntityLinks";

interface MarkdownBodyProps {
  children: string;
  className?: string;
  style?: React.CSSProperties;
  softBreaks?: boolean;
  linkTaskReferences?: boolean;
  /** Opt into Obsidian-style [[target]] / [[target|label]] wikilinks. */
  enableWikiLinks?: boolean;
  /** Base href used for wikilinks when no resolver is supplied. */
  wikiLinkRoot?: string;
  /** Optional href resolver for wikilinks. Return null to leave a token as plain text. */
  resolveWikiLinkHref?: (target: string, label: string) => string | null | undefined;
  /** Optional resolver for relative image paths (e.g. within export packages) */
  resolveImageSrc?: (src: string) => string | null;
  /** Called when a user clicks an inline image */
  onImageClick?: (src: string) => void;
}

export function MarkdownBodyImpl({
  children,
  className,
  style,
  softBreaks = true,
  linkTaskReferences = true,
  enableWikiLinks = false,
  wikiLinkRoot,
  resolveWikiLinkHref,
  resolveImageSrc,
  onImageClick,
}: MarkdownBodyProps) {
  const { theme } = useTheme();
  // MarkdownBody also renders outside CompanyProvider; those surfaces can
  // render task:// references but cannot resolve them into company routes.
  const companyId = useOptionalCompany()?.selectedCompany?.id ?? null;
  // Stable identity so it can feed the memoized remark plugins without
  // re-creating them (and forcing a full markdown re-parse) every render.
  // react-markdown treats the values of `components` as component *types* and
  // the `remarkPlugins` array by identity. Rebuilding either on every render
  // forces react-markdown to unmount/remount the rendered tree, which discards
  // scroll position and text selection and causes visible flashing when a
  // parent re-renders frequently (see PAP-10767). Memoize both so re-renders
  // that don't change the inputs are cheap and non-destructive.
  const remarkPlugins = useMemo<NonNullable<Options["remarkPlugins"]>>(() => {
    const plugins: NonNullable<Options["remarkPlugins"]> = [remarkGfm, remarkDropHtmlComments];
    if (enableWikiLinks) {
      plugins.push(createRemarkWikiLinks({ wikiLinkRoot, resolveWikiLinkHref }));
    }
    if (linkTaskReferences) {
      plugins.push(remarkLinkTaskReferences);
    }
    if (softBreaks) {
      plugins.push(remarkSoftBreaks);
    }
    return plugins;
  }, [enableWikiLinks, wikiLinkRoot, resolveWikiLinkHref, linkTaskReferences, softBreaks]);
  const components = useMemo<Components>(() => {
    const map: Components = {
      p: ({ node: _node, style: paragraphStyle, children: paragraphChildren, ...paragraphProps }) => (
        <p {...paragraphProps} style={mergeWrapStyle(paragraphStyle as React.CSSProperties | undefined)}>
          {paragraphChildren}
        </p>
      ),
      li: ({ node: _node, style: listItemStyle, children: listItemChildren, ...listItemProps }) => (
        <li {...listItemProps} style={mergeWrapStyle(listItemStyle as React.CSSProperties | undefined)}>
          {listItemChildren}
        </li>
      ),
      blockquote: ({
        node: _node,
        style: blockquoteStyle,
        children: blockquoteChildren,
        ...blockquoteProps
      }) => (
        <blockquote
          {...blockquoteProps}
          style={mergeWrapStyle(blockquoteStyle as React.CSSProperties | undefined)}
        >
          {blockquoteChildren}
        </blockquote>
      ),
      table: ({ node: _node, style: tableStyle, children: tableChildren, ...tableProps }) => (
        <Table {...tableProps} style={tableStyle as React.CSSProperties | undefined}>
          {tableChildren}
        </Table>
      ),
      td: ({ node: _node, style: tableCellStyle, children: tableCellChildren, ...tableCellProps }) => (
        <TableCell
          {...tableCellProps}
          style={mergeTableCellStyle(tableCellStyle as React.CSSProperties | undefined)}
        >
          {tableCellChildren}
        </TableCell>
      ),
      th: ({ node: _node, style: tableHeaderStyle, children: tableHeaderChildren, ...tableHeaderProps }) => (
        <TableHead
          {...tableHeaderProps}
          style={mergeTableCellStyle(tableHeaderStyle as React.CSSProperties | undefined)}
        >
          {tableHeaderChildren}
        </TableHead>
      ),
      pre: ({ node: _node, children: preChildren }) => {
        const mermaidSource = extractMermaidSource(preChildren);
        if (mermaidSource) {
          return <MermaidDiagramBlock source={mermaidSource} darkMode={theme === "dark"} />;
        }
        return <MarkdownCodeBlock>{preChildren}</MarkdownCodeBlock>;
      },
      code: ({ node: _node, style: codeStyle, children: codeChildren, ...codeProps }) => (
        <code {...codeProps} style={mergeWrapStyle(codeStyle as React.CSSProperties | undefined)}>
          {codeChildren}
        </code>
      ),
      a: ({ node: _node, href, style: linkStyle, children: linkChildren, ...anchorProps }) => {
        const dataProps = anchorProps as Record<string, unknown>;
        const isWikiLink = dataProps["data-paperclip-wiki-link"] === "true";
        if (isWikiLink && href && companyId && !/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith("//")) {
          return (
            <Link
              to={resolvePluginNavigationHref(href, companyId)}
              {...anchorProps}
              rel="noreferrer"
              style={mergeWrapStyle(linkStyle as React.CSSProperties | undefined)}
            >
              {linkChildren}
            </Link>
          );
        }

        const taskRef = linkTaskReferences ? parseTaskReferenceFromHref(href) : null;
        if (taskRef) {
          return <MarkdownTaskLink taskId={taskRef.taskId}>{linkChildren}</MarkdownTaskLink>;
        }

        const parsed = href ? parseMentionChipHref(href) : null;
        if (parsed && companyId) {
          const mentionLinkProps = {
            className: cn(
              "paperclip-mention-chip",
              `paperclip-mention-chip--${parsed.kind}`,
              parsed.kind === "project" && "paperclip-project-mention-chip",
            ),
            "data-mention-kind": parsed.kind,
            style: {
              ...mergeWrapStyle(linkStyle as React.CSSProperties | undefined),
              ...mentionChipInlineStyle(parsed),
            },
          };
          return parsed.kind === "task" ? (
            <TaskLinkQuicklook taskId={parsed.taskId} taskNumber={null} {...mentionLinkProps}>
              {linkChildren}
            </TaskLinkQuicklook>
          ) : parsed.kind === "project" ? (
            <MarkdownProjectMentionLink
              companyId={companyId}
              entityId={parsed.projectId}
              linkProps={mentionLinkProps}
            >
              {linkChildren}
            </MarkdownProjectMentionLink>
          ) : parsed.kind === "routine" ? (
            <Link
              to="/$companyId/routines/$routineId"
              params={{ companyId, routineId: parsed.routineId }}
              {...mentionLinkProps}
            >
              {linkChildren}
            </Link>
          ) : parsed.kind === "user" ? (
            <Link to="/$companyId/company/settings/members" params={{ companyId }} {...mentionLinkProps}>
              {linkChildren}
            </Link>
          ) : (
            <MarkdownAgentMentionLink
              companyId={companyId}
              entityId={parsed.agentId}
              linkProps={mentionLinkProps}
            >
              {linkChildren}
            </MarkdownAgentMentionLink>
          );
        }
        const isGitHubLink = isGitHubUrl(href);
        const isExternal = isExternalHttpUrl(href);
        const leadingIcon = isGitHubLink ? (
          <Github aria-hidden="true" className="mr-1 inline h-3.5 w-3.5 align-(--va-0_125em)" />
        ) : null;
        const trailingIcon =
          isExternal && !isGitHubLink ? (
            <ExternalLink aria-hidden="true" className="ml-1 inline h-3 w-3 align-(--va-0_125em)" />
          ) : null;
        if (!isExternal && !isNonRouterAnchor(href, anchorProps.download)) {
          return (
            <span style={mergeWrapStyle(linkStyle as React.CSSProperties | undefined)}>{linkChildren}</span>
          );
        }
        return (
          <a
            href={href}
            {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : { rel: "noreferrer" })}
            style={mergeWrapStyle(linkStyle as React.CSSProperties | undefined)}
          >
            {renderLinkBody(linkChildren, leadingIcon, trailingIcon)}
          </a>
        );
      },
    };
    if (resolveImageSrc || onImageClick) {
      map.img = ({ node: _node, src, alt, ...imgProps }) => {
        const resolved = resolveImageSrc && src ? resolveImageSrc(src) : null;
        const finalSrc = resolved ?? src;
        return (
          <img
            {...imgProps}
            src={finalSrc}
            alt={alt ?? ""}
            onClick={
              onImageClick && finalSrc
                ? (e) => {
                    e.preventDefault();
                    onImageClick(finalSrc);
                  }
                : undefined
            }
            style={
              onImageClick
                ? {
                    cursor: "pointer",
                    ...(imgProps.style as React.CSSProperties | undefined),
                  }
                : (imgProps.style as React.CSSProperties | undefined)
            }
          />
        );
      };
    }
    return map;
  }, [companyId, theme, linkTaskReferences, resolveImageSrc, onImageClick]);

  return (
    <div
      className={cn(
        "paperclip-markdown prose prose-sm min-w-0 max-w-full break-words overflow-hidden",
        theme === "dark" && "prose-invert",
        className,
      )}
      style={mergeWrapStyle(style)}
    >
      <Markdown remarkPlugins={remarkPlugins} components={components} urlTransform={safeMarkdownUrlTransform}>
        {children}
      </Markdown>
    </div>
  );
}

export const MarkdownBody = memo(MarkdownBodyImpl);

export * from "./MarkdownCodeBlock";
export * from "./MarkdownEntityLinks";
export * from "./MarkdownTransforms";
export * from "./MermaidDiagramBlock";
