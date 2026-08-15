import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  DocumentAnnotationThreadWithComments,
  DocumentAnnotationThreadStatus,
  DocumentAnnotationAnchorState,
} from "@paperclipai/shared";
import { DocumentAnnotationPanel } from "@/routes/_authenticated/$companyId/-document-annotations/-DocumentAnnotationPanel";
import type { PendingAnchor } from "@/routes/_authenticated/$companyId/-document-annotations/-DocumentAnnotationLayer";
import type { CompanyUserProfile } from "@/lib/company-members";
import { queryKeys } from "@/lib/queryKeys";

const taskId = "dddddddd-dddd-4ddd-8ddd-ddddddddd013";
const documentKey = "plan";
const currentUserId = "a7000000-0000-4000-8000-000000000002";

const userProfileMap = new Map<string, CompanyUserProfile>([
  [currentUserId, { label: "Dotta", image: null }],
  ["a7000000-0000-4000-8000-000000000004", { label: "Mara Product", image: null }],
]);

function makeThread(
  overrides: Partial<DocumentAnnotationThreadWithComments> = {},
): DocumentAnnotationThreadWithComments {
  const id = overrides.id ?? "a9000000-0000-4000-8000-000000000001";
  const status: DocumentAnnotationThreadStatus = overrides.status ?? "open";
  const anchorState: DocumentAnnotationAnchorState = overrides.anchorState ?? "active";
  return {
    id,
    companyId: "11111111-1111-4111-8111-111111111111",
    taskId,
    documentId: "a2000000-0000-4000-8000-000000000004",
    documentKey,
    status,
    anchorState,
    anchorConfidence: "exact",
    originalRevisionId: "a2100000-0000-4000-8000-000000000005",
    originalRevisionNumber: 4,
    currentRevisionId: "a2100000-0000-4000-8000-000000000005",
    currentRevisionNumber: 4,
    selectedText:
      "the assistant should keep the existing editor selection highlighted while the comment composer is open",
    prefixText: "We agreed ",
    suffixText: ".",
    normalizedStart: 0,
    normalizedEnd: 22,
    markdownStart: 0,
    markdownEnd: 22,
    anchorSelector: {
      quote: { exact: "selection", prefix: "We ", suffix: "." },
      position: { normalizedStart: 0, normalizedEnd: 22, markdownStart: 0, markdownEnd: 22 },
    },
    createdByAgentId: null,
    createdByUserId: currentUserId,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: new Date("2026-06-12T00:01:00Z"),
    updatedAt: new Date("2026-06-12T00:02:00Z"),
    comments: [
      {
        id: `${id}-c1`,
        companyId: "11111111-1111-4111-8111-111111111111",
        threadId: id,
        taskId,
        documentId: "a2000000-0000-4000-8000-000000000004",
        body: "Please confirm this is still the behaviour we want.",
        authorType: "user",
        authorAgentId: null,
        authorUserId: "a7000000-0000-4000-8000-000000000004",
        createdByRunId: null,
        createdAt: new Date("2026-06-12T00:01:00Z"),
        updatedAt: new Date("2026-06-12T00:01:00Z"),
      },
    ],
    ...overrides,
  };
}

const pendingAnchor: PendingAnchor = {
  selector: {
    quote: { exact: "extremely snappy", prefix: "feels ", suffix: "." },
    position: { normalizedStart: 0, normalizedEnd: 16, markdownStart: 0, markdownEnd: 16 },
  },
  selectedText:
    "submission of comments should be optimistic so the whole interaction feels extremely snappy",
};

function PanelFrame({
  label,
  threads,
  focusedThreadId = null,
  pending = null,
}: {
  label: string;
  threads: DocumentAnnotationThreadWithComments[];
  focusedThreadId?: string | null;
  pending?: PendingAnchor | null;
}) {
  const [client] = useState(() => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(queryKeys.auth.session, {
      session: { id: "b0000000-0000-4000-8000-000000000002", userId: currentUserId },
      user: { id: currentUserId, email: "dotta@example.local", name: "Dotta", image: null },
    });
    return qc;
  });
  const [focused, setFocused] = useState<string | null>(focusedThreadId);

  return (
    <div className="flex flex-col gap-2">
      <div className="paperclip-story__label">{label}</div>
      <QueryClientProvider client={client}>
        <div className="h-[460px]">
          <DocumentAnnotationPanel
            open
            onOpenChange={() => undefined}
            target={{ kind: "task", taskId, documentKey }}
            documentRevisionNumber={4}
            baseRevisionId="a2100000-0000-4000-8000-000000000005"
            baseRevisionNumber={4}
            threads={threads}
            focusedThreadId={focused}
            onFocusThread={setFocused}
            focusedCommentId={null}
            pendingAnchor={pending}
            onClearPendingAnchor={() => undefined}
            desktopWidth={360}
            userProfileMap={userProfileMap}
          />
        </div>
      </QueryClientProvider>
    </div>
  );
}

function DocumentCommentsMatrix() {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner">
        <section className="paperclip-story__frame overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <div className="paperclip-story__label">Document comments · PAP-10960</div>
            <h2 className="mt-1 text-xl font-semibold">Simplified annotation panel</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              No header, no filter chips, no empty-state copy. Revision indicator sits top-right.
              The composer shows the author avatar + name, two-line clamped quote, and a plain
              "Reply" affordance.
            </p>
          </div>
          <div className="flex flex-wrap items-start gap-6 p-5">
            <PanelFrame label="No comments yet" threads={[]} />
            <PanelFrame
              label="With comments (one expanded)"
              threads={[
                makeThread({ id: "a9000000-0000-4000-8000-000000000001" }),
                makeThread({ id: "a9000000-0000-4000-8000-000000000002", status: "resolved", selectedText: "a resolved thread stays in the same list" }),
              ]}
              focusedThreadId="a9000000-0000-4000-8000-000000000001"
            />
            <PanelFrame label="Composing a new comment" threads={[makeThread({ id: "a9000000-0000-4000-8000-000000000001" })]} pending={pendingAnchor} />
          </div>
        </section>
      </main>
    </div>
  );
}

const meta = {
  title: "Product/Document Comments",
  component: DocumentCommentsMatrix,
  parameters: {
    docs: {
      description: {
        component:
          "Inline document comment panel (PAP-10960): simplified to drop the header, filter chips, and empty-state, surface the author identity in the composer, and clamp quotes to two lines.",
      },
    },
  },
} satisfies Meta<typeof DocumentCommentsMatrix>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Panel: Story = {};
