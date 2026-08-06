import {
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialogState } from "../context/DialogContext";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { goalsApi } from "../api/goals";
import { queryKeys } from "../lib/queryKeys";
import { MarkdownBody } from "../components/MarkdownBody";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Activity, ArrowDown, History, MessageSquarePlus } from "lucide-react";
import { ActivityFeed } from "../components/ActivityFeed";
import { ChatComposer, type ChatComposerHandle } from "../components/ChatComposer";
import {
  AgentBubbleActionRow,
  agentBubbleDateLabel,
} from "../components/AgentBubbleActionRow";
import { AgentIcon } from "../components/AgentIconPicker";
import { cn, formatDateTime } from "../lib/utils";
import type {
  Issue,
  ContextAccess,
} from "@paperclipai/shared";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { IssueContextAccessMaskMatrix } from "../components/IssueContextAccessMaskMatrix";
import { flattenBoardIssueCommentGroupPages } from "../lib/optimistic-issue-comments";

/**
 * Board Chat is a focused presentation of an ordinary user-created issue.
 * Its special route creates the issue only. Follow-ups and closing use the
 * canonical creator and owner forms; replies remain canonical comments.
 */
/** Hit zone to the right of the 1px line (line sits on chat pane’s right edge). */
const SPLIT_DIVIDER_PX = 12;
const SPLIT_MIN_PANE_PX = 280;
/** Chat pane share of width below the divider (agent feed gets the rest). */
const DEFAULT_CHAT_FRACTION = 2 / 3;


/** Wrapped markdown in bubbles; pre/table scroll horizontally when needed. */
const BOARD_CHAT_MARKDOWN_CLASS =
  "max-w-full overflow-visible [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto";

const boardChatBubbleShell =
  "min-w-0 max-w-(--pct-85) break-words px-3 py-2 text-sm overflow-x-auto overflow-y-visible";

/** First-letter(s) fallback for an agent with no icon. */
function agentInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase()) || "A";
}

/**
 * Icon-adjacent-to-name header rendered directly above an agent bubble —
 * the shared `[agent icon][agent name]` convention (PAP-105 / PAP-97).
 */
function AgentBubbleHeader({ name, icon }: { name: string; icon: string | null }) {
  return (
    <div className="mb-1 flex items-center gap-1.5 pl-1">
      <Avatar size="sm" className="shrink-0">
        <AvatarFallback>
          {icon ? (
            <AgentIcon icon={icon} className="h-3.5 w-3.5" />
          ) : (
            agentInitials(name)
          )}
        </AvatarFallback>
      </Avatar>
      <span className="text-sm font-medium text-foreground">{name}</span>
    </div>
  );
}

/** Agent-styled chat bubble containing the three-dot typing indicator. */
function TypingBubble() {
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          boardChatBubbleShell,
          "bg-card border border-border text-foreground [border-radius:14px_14px_14px_4px]",
        )}
      >
        <span className="typing-dots" aria-label="typing">
          <span />
          <span />
          <span />
        </span>
      </div>
    </div>
  );
}

export function BoardChat() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Conference Room" }]);
  }, [setBreadcrumbs]);

  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [chatPaneFraction, setChatPaneFraction] = useState(DEFAULT_CHAT_FRACTION);
  const splitDragging = useRef(false);


  useLayoutEffect(() => {
    const el = splitContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setContainerWidth(el.clientWidth);
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const innerWidth = Math.max(0, containerWidth - SPLIT_DIVIDER_PX);
  const splitLowerPx = SPLIT_MIN_PANE_PX;
  const splitUpperPx = innerWidth - SPLIT_MIN_PANE_PX;
  const minChatFraction =
    innerWidth > 0 ? Math.min(1, SPLIT_MIN_PANE_PX / innerWidth) : 0;
  const maxChatFraction =
    innerWidth > 0 ? Math.max(0, 1 - SPLIT_MIN_PANE_PX / innerWidth) : 1;
  const leftPaneWidth =
    innerWidth > 0
      ? splitUpperPx < splitLowerPx
        ? Math.max(0, Math.round(innerWidth / 2))
        : Math.round(
            innerWidth *
              Math.min(
                maxChatFraction,
                Math.max(minChatFraction, chatPaneFraction),
              ),
          )
      : 0;

  const handleSplitDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      splitDragging.current = true;
      const startX = e.clientX;
      const startWidth = leftPaneWidth;

      const onMouseMove = (ev: MouseEvent) => {
        if (!splitDragging.current) return;
        const containerW = splitContainerRef.current?.clientWidth ?? containerWidth;
        const inner = containerW - SPLIT_DIVIDER_PX;
        const lower = SPLIT_MIN_PANE_PX;
        const upper = inner - SPLIT_MIN_PANE_PX;
        const next = startWidth + ev.clientX - startX;
        if (inner <= 0) return;
        if (upper < lower) {
          setChatPaneFraction(0.5);
        } else {
          const clamped = Math.min(upper, Math.max(lower, next));
          setChatPaneFraction(clamped / inner);
        }
      };

      const onMouseUp = () => {
        splitDragging.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [containerWidth, leftPaneWidth],
  );

  const [input, setInput] = useState("");
  /** Guards the draft-persistence effect so it doesn't overwrite a saved
   *  draft with "" before we've had a chance to load it. */
  const loadedDraftCompanyRef = useRef<string | null>(null);
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);
  const isPending = sending || closing;
  const [errorText, setErrorText] = useState("");
  const [boardIssueId, setBoardIssueId] = useState<string | null>(null);
  const [optimisticMessage, setOptimisticMessage] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const hasRestoredScrollRef = useRef(false);
  const composerRef = useRef<ChatComposerHandle>(null);

  /** True when the user is scrolled away from the bottom AND new content
   *  has arrived they can't see. Drives the floating "jump to latest" chip. */
  const [hasNewBelow, setHasNewBelow] = useState(false);

  /** Tracks whether the user was near the bottom BEFORE the latest content
   *  change. Updated on scroll events (and after programmatic scrolls) so
   *  that when a tall new message inflates scrollHeight, we still know the
   *  user's pre-update position and can decide whether to auto-scroll. */
  const wasNearBottomRef = useRef(true);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior, block: "end" });
    wasNearBottomRef.current = true;
    setHasNewBelow(false);
  }, []);

  // Welcome typing intro: staged reveal of typing → welcome bubble → chips.
  // The timers don't start until the data needed to render the welcome is
  // actually loaded, so the animation plays at the moment the user arrives
  // at the chat (e.g. right after creating a new company) rather than
  // burning off while a spinner is on screen.
  const [welcomeRevealed, setWelcomeRevealed] = useState(false);
  const [chipsRevealed, setChipsRevealed] = useState(false);

  // Restore only the issue explicitly opened in this browser tab. Board Chat
  // never scans for or revives a standing concierge issue.
  useEffect(() => {
    setSending(false);
    setOptimisticMessage(null);
    setErrorText("");
    hasRestoredScrollRef.current = false;
    if (!selectedCompanyId) {
      setBoardIssueId(null);
      return;
    }
    try {
      setBoardIssueId(
        sessionStorage.getItem(
          `paperclip.boardChat.issue.${selectedCompanyId}`,
        ),
      );
    } catch {
      setBoardIssueId(null);
    }
  }, [selectedCompanyId]);

  // Load a saved composer draft (if any) whenever the active company
  // changes — runs on first mount too.
  useEffect(() => {
    if (!selectedCompanyId) return;
    if (loadedDraftCompanyRef.current === selectedCompanyId) return;
    try {
      const saved = sessionStorage.getItem(
        `paperclip.boardChat.draft.${selectedCompanyId}`,
      );
      setInput(saved ?? "");
    } catch {
      setInput("");
    }
    loadedDraftCompanyRef.current = selectedCompanyId;
  }, [selectedCompanyId]);

  // Persist composer draft to sessionStorage on change (per company).
  // Only runs after the initial load for this company to avoid clobbering
  // a saved draft with an empty initial value.
  useEffect(() => {
    if (!selectedCompanyId) return;
    if (loadedDraftCompanyRef.current !== selectedCompanyId) return;
    try {
      const key = `paperclip.boardChat.draft.${selectedCompanyId}`;
      if (input) {
        sessionStorage.setItem(key, input);
      } else {
        sessionStorage.removeItem(key);
      }
    } catch { /* sessionStorage unavailable */ }
  }, [input, selectedCompanyId]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const issueOwnerCatalogQuery = useQuery({
    queryKey: queryKeys.agents.issueOwnerCatalog(selectedCompanyId!),
    queryFn: () => agentsApi.listInvokableIssueOwners(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [contextAccessMask, setContextAccessMask] =
    useState<ContextAccess | null>(null);
  const selectableAgents = useMemo(
    () => issueOwnerCatalogQuery.data ?? [],
    [issueOwnerCatalogQuery.data],
  );
  const selectedAgent = useMemo(
    () =>
      selectableAgents.find((agent) => agent.id === selectedAgentId) ??
      (boardIssueId
        ? (agents ?? []).find((agent) => agent.id === selectedAgentId) ?? null
        : null),
    [agents, boardIssueId, selectableAgents, selectedAgentId],
  );

  useEffect(() => {
    if (
      boardIssueId ||
      !selectedAgentId ||
      !issueOwnerCatalogQuery.isSuccess
    ) {
      return;
    }
    if (!selectableAgents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId("");
    }
  }, [
    boardIssueId,
    issueOwnerCatalogQuery.isSuccess,
    selectableAgents,
    selectedAgentId,
  ]);

  // Pull the company's top-level goal so the selected agent's welcome can reference
  // the mission verbatim.
  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const missionText = useMemo(() => {
    const active = (goals ?? []).find((g) => g.status === "active");
    return active?.title ?? null;
  }, [goals]);

  const { data: boardIssue } = useQuery({
    queryKey: queryKeys.issues.detail(boardIssueId ?? ""),
    queryFn: () => issuesApi.get(boardIssueId!),
    enabled: !!boardIssueId,
    refetchInterval: boardIssueId ? 3000 : false,
  });

  useEffect(() => {
    if (boardIssue?.ownerAgentId) {
      setSelectedAgentId(boardIssue.ownerAgentId);
    }
  }, [boardIssue?.ownerAgentId]);

  const boardIssueTerminal =
    boardIssue?.lifecycleStatus === "done" || boardIssue?.lifecycleStatus === "cancelled";

  // The issue request and every subsequent turn are projected into the same
  // durable chronological thread; there is no provider draft stream.
  const { data: comments } = useQuery({
    queryKey: queryKeys.issues.comments(boardIssueId ?? ""),
    queryFn: () => issuesApi.listComments(boardIssueId!),
    enabled: !!boardIssueId,
    refetchInterval: 3000,
  });

  const sortedComments = useMemo(
    () => flattenBoardIssueCommentGroupPages(
      comments ? [comments] : undefined,
      {
        companyId: boardIssue?.companyId ?? selectedCompanyId ?? "",
        issueId: boardIssueId ?? "",
      },
    ),
    [boardIssue?.companyId, boardIssueId, comments, selectedCompanyId],
  );

  // Agent lookup so each bubble can show its author's name + icon header.
  const agentMap = useMemo(
    () => new Map((agents ?? []).map((a) => [a.id, a] as const)),
    [agents],
  );

  // Reset the staged reveal on mount AND whenever the active company
  // changes, so every arrival at the Conference Room replays the typing
  // intro from scratch (a freshly-created company included). The effect's
  // mount run is intentional — it keeps the intro fresh even if a future
  // refactor preserves this component instance across navigations (PAP-134).
  useEffect(() => {
    setWelcomeRevealed(false);
    setChipsRevealed(false);
  }, [selectedCompanyId]);

  // The onboarding wizard renders as an overlay above an already-mounted
  // Conference Room (sidebar "Create new company..." path). Holding the reveal
  // timer while it's open guarantees the dots window can't burn off behind
  // the wizard before the user ever sees the chat (PAP-134).
  const { onboardingOpen } = useDialogState();

  // Likewise, don't let the dots window burn while the tab is hidden —
  // e.g. the user completes the wizard, switches tabs, and comes back.
  const [pageVisible, setPageVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const onVisibilityChange = () =>
      setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // Start the typing → welcome timer only once we have the ingredients
  // needed to render the welcome bubble. This guarantees the animation is
  // visible at the moment the user arrives, even if agent/goal queries
  // take a beat to resolve.
  const canRenderWelcome = !!selectedAgent && !!selectedCompany;
  useEffect(() => {
    if (!canRenderWelcome) return;
    if (welcomeRevealed) return;
    if (onboardingOpen || !pageVisible) return;
    const timeout = setTimeout(() => setWelcomeRevealed(true), 2000);
    return () => clearTimeout(timeout);
  }, [canRenderWelcome, welcomeRevealed, onboardingOpen, pageVisible]);

  // Stage the suggestion chips in shortly after the welcome bubble lands
  // so the eye reads the message first, then the actions.
  useEffect(() => {
    if (!welcomeRevealed) return;
    if (chipsRevealed) return;
    const timeout = setTimeout(() => setChipsRevealed(true), 700);
    return () => clearTimeout(timeout);
  }, [welcomeRevealed, chipsRevealed]);

  // If the user has already replied in this conversation, fast-forward
  // past the intro — the welcome isn't a "new" event anymore.
  useEffect(() => {
    if (welcomeRevealed && chipsRevealed) return;
    if (!comments) return;
    const userHasReplied = sortedComments.some((comment) => !comment.authorAgentId);
    if (userHasReplied) {
      setWelcomeRevealed(true);
      setChipsRevealed(true);
    }
  }, [comments, sortedComments, welcomeRevealed, chipsRevealed]);

  // Clear optimistic message once server-persisted comments include it
  useEffect(() => {
    if (optimisticMessage && sortedComments.length > 0) {
      const lastUserComment = [...sortedComments]
        .reverse()
        .find((c) => !c.authorAgentId);
      if (lastUserComment?.body === optimisticMessage) {
        setOptimisticMessage(null);
      }
    }
  }, [sortedComments, optimisticMessage]);

  // Scroll behavior:
  //   - First mount in a session (no saved position): jump to bottom instantly.
  //   - Returning to the page within the same session: restore last scrollTop.
  //   - New content arriving: smooth-scroll to bottom only if user is already
  //     near the bottom, so we don't yank them away from reading history.
  //   - Scroll position is persisted to sessionStorage (cleared when tab closes).
  useEffect(() => {
    if (hasRestoredScrollRef.current) return;
    if (sortedComments.length === 0) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    try {
      const saved = sessionStorage.getItem("paperclip.boardChat.scrollTop");
      if (saved != null) {
        const parsed = Number(saved);
        if (Number.isFinite(parsed)) {
          container.scrollTop = parsed;
          hasRestoredScrollRef.current = true;
          return;
        }
      }
    } catch { /* sessionStorage unavailable */ }

    container.scrollTop = container.scrollHeight;
    hasRestoredScrollRef.current = true;
  }, [sortedComments.length]);

  // User sent a message: always scroll so their just-typed message is in
  // view, even if they were scrolled up reading history.
  useEffect(() => {
    if (!optimisticMessage) return;
    scrollToLatest("smooth");
  }, [optimisticMessage, scrollToLatest]);

  // Auto-scroll for new durable comments only when the reader was already
  // near the bottom.
  useEffect(() => {
    if (!hasRestoredScrollRef.current) return;
    if (wasNearBottomRef.current) {
      scrollToLatest("smooth");
    } else {
      setHasNewBelow(true);
    }
  }, [sortedComments.length, scrollToLatest]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    let rafId: number | null = null;
    const handleScroll = () => {
      const near = container.scrollHeight - container.scrollTop - container.clientHeight <= 80;
      wasNearBottomRef.current = near;
      if (near) setHasNewBelow(false);

      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        try {
          sessionStorage.setItem(
            "paperclip.boardChat.scrollTop",
            String(container.scrollTop),
          );
        } catch { /* sessionStorage unavailable */ }
      });
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, []);

  const sendMessage = useCallback(
    async (body: string) => {
      if (
        !body.trim() ||
        sending ||
        !selectedCompanyId ||
        !selectedAgent ||
        boardIssueTerminal
      ) {
        return;
      }

      setOptimisticMessage(body);
      setSending(true);
      setInput("");
      setErrorText("");

      try {
        let nextIssueId: string;
        let nextIssue: Issue | undefined;
        if (boardIssueId) {
          await issuesApi.commitCreatorFormUpdate({
            issueId: boardIssueId,
            message: body,
          });
          nextIssueId = boardIssueId;
        } else {
          const res = await fetch("/api/board/chat/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              companyId: selectedCompanyId,
              agentId: selectedAgent.id,
              message: body,
              ...(contextAccessMask ? { contextAccessMask } : {}),
              idempotencyKey: crypto.randomUUID(),
            }),
          });
          const payload = (await res.json()) as {
            error?: string;
            issueId?: string;
            issue?: Issue;
          };
          if (!res.ok || !payload.issueId) {
            throw new Error(
              payload.error || "Board Chat request was rejected",
            );
          }
          nextIssueId = payload.issueId;
          nextIssue = payload.issue;
        }

        if (nextIssue) {
          queryClient.setQueryData(
            queryKeys.issues.detail(nextIssueId),
            nextIssue,
          );
        }
        setBoardIssueId(nextIssueId);
        try {
          sessionStorage.setItem(
            `paperclip.boardChat.issue.${selectedCompanyId}`,
            nextIssueId,
          );
        } catch {
          // sessionStorage is an optional UI convenience, never the record.
        }
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: queryKeys.issues.detail(nextIssueId),
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.issues.comments(nextIssueId),
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.issues.list(selectedCompanyId),
          }),
        ]);
        setContextAccessMask(null);
      } catch (err) {
        console.error("Board chat error:", err);
        setInput(body);
        setOptimisticMessage(null);
        setErrorText(
          err instanceof Error
            ? err.message
            : "The Board Chat request could not be admitted.",
        );
      } finally {
        setSending(false);
        composerRef.current?.focus();
      }
    },
    [
      sending,
      selectedCompanyId,
      selectedAgent,
      boardIssueId,
      boardIssueTerminal,
      contextAccessMask,
      queryClient,
    ],
  );

  const startNewChat = useCallback(async () => {
    if (closing || sending) return;
    setClosing(true);
    setErrorText("");
    try {
      if (boardIssueId && !boardIssueTerminal) {
        let issueForCancellation = boardIssue;
        if (
          issueForCancellation?.ownerKind === "agent" &&
          issueForCancellation.ownerAgentId
        ) {
          const reassigned = await issuesApi.selfAssignForWithdrawal(
            boardIssueId,
            { idempotencyKey: crypto.randomUUID() },
          );
          issueForCancellation = reassigned.issue;
          queryClient.setQueryData(
            queryKeys.issues.detail(boardIssueId),
            reassigned.issue,
          );
        }
        if (
          issueForCancellation?.ownerKind !== "user" ||
          issueForCancellation.ownerAssignmentSource !==
            "user_creator_withdrawal"
        ) {
          throw new Error(
            "This Board Chat issue cannot be withdrawn by its creator.",
          );
        }
        await issuesApi.commitOwnerFormUpdate({
          issueId: boardIssueId,
          message: "Closed from Board Chat.",
          status: "cancelled",
        });
      }
    if (boardIssueId) {
      queryClient.removeQueries({
        queryKey: queryKeys.issues.comments(boardIssueId),
      });
      queryClient.removeQueries({
        queryKey: queryKeys.issues.detail(boardIssueId),
      });
    }
    setBoardIssueId(null);
    setContextAccessMask(null);
    setOptimisticMessage(null);
    setErrorText("");
    hasRestoredScrollRef.current = false;
    if (selectedCompanyId) {
      try {
        sessionStorage.removeItem(
          `paperclip.boardChat.issue.${selectedCompanyId}`,
        );
      } catch {
        // sessionStorage is optional.
      }
    }
    composerRef.current?.focus();
    } catch (err) {
      setErrorText(
        err instanceof Error
          ? err.message
          : "The current Board Chat issue could not be closed.",
      );
    } finally {
      setClosing(false);
    }
  }, [
    boardIssue,
    boardIssueId,
    boardIssueTerminal,
    closing,
    queryClient,
    selectedCompanyId,
    sending,
  ]);

  const handleSend = useCallback(() => {
    sendMessage(input);
  }, [input, sendMessage]);

  // NOTE: declared before the early return below — all hooks must run on
  // every render (Rules of Hooks). Placing it after the `!selectedCompanyId`
  // guard caused "Rendered more hooks than during the previous render" and a
  // blank page once a company was selected.
  const [mobileFeedOpen, setMobileFeedOpen] = useState(false);

  if (!selectedCompanyId) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-sm">
          <h2 className="text-lg font-semibold">No company selected</h2>
          <p className="text-sm text-muted-foreground mt-2">
            Select a company to start a Board Chat issue.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-(--sz-calc-29) flex-col -m-6">
      <div
        ref={splitContainerRef}
        className="flex min-h-0 min-w-0 flex-1 flex-row"
      >
        {/* Left: chat (self-contained pane) — full width on mobile, 2/3 default on desktop */}
        <div
          className={cn(
            "relative flex min-h-0 min-w-0 shrink-0 flex-col bg-background",
            "w-full md:w-auto",
            innerWidth <= 0 && "md:w-2/3",
          )}
          style={innerWidth > 0 && containerWidth >= 2 * SPLIT_MIN_PANE_PX + SPLIT_DIVIDER_PX ? { width: leftPaneWidth } : undefined}
        >
          <div className="relative flex shrink-0 items-center justify-between gap-2 px-4 py-3">
            <div
              className="pointer-events-none absolute bottom-0 left-0 right-0 h-px bg-border"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">
                {selectedAgent?.name ?? "Conference Room"}
              </h3>
              <p className="text-xs text-muted-foreground">
                {selectedCompany?.name ?? "Your company"}
              </p>
              <select
                className="mt-1 max-w-full rounded border border-border bg-background px-2 py-1 text-xs"
                value={selectedAgentId}
                onChange={(event) => setSelectedAgentId(event.target.value)}
                aria-label="Board Chat agent"
                disabled={!!boardIssueId}
              >
                <option value="">Select an agent…</option>
                {selectableAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}{agent.title ? ` — ${agent.title}` : ""}
                  </option>
                ))}
              </select>
              <div className="mt-2 max-w-2xl">
                <IssueContextAccessMaskMatrix
                  value={
                    boardIssue
                      ? boardIssue.contextAccessMask ?? null
                      : contextAccessMask
                  }
                  onChange={
                    boardIssueId ? undefined : setContextAccessMask
                  }
                  readOnly={Boolean(boardIssueId)}
                />
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    aria-label="chat history"
                    asChild
                    disabled={!boardIssue}
                  >
                    <a
                      aria-label="Open chat history"
                      href={
                        boardIssue
                          ? `/issues/${boardIssue.identifier ?? boardIssue.id}`
                          : "/issues"
                      }
                    >
                      <History className="h-4 w-4" />
                    </a>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">chat history</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    aria-label="new chat"
                    onClick={() => void startNewChat()}
                    disabled={closing || sending}
                  >
                    <MessageSquarePlus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">new chat</TooltipContent>
              </Tooltip>
            </div>
          </div>
          {/* Messages — scroll viewport flush right so the scrollbar sits on the pane/divider edge */}
          <div className="relative min-h-0 min-w-0 flex-1">
          <div
            ref={scrollContainerRef}
            className="scrollbar-auto-hide absolute inset-0 overflow-y-auto overflow-x-hidden"
          >
            {/* pb clears the floating glass dock (PAP-131) so the last bubble can
                 scroll fully above the composer. */}
            <div className="flex flex-col gap-4 px-6 pt-3 pb-32">
              {/* Typing bubble — shown unconditionally until the reveal
                   timer fires, so the animation is guaranteed to be
                   visible even while agent/goal data is still loading. */}
              {!welcomeRevealed && <TypingBubble />}

              {welcomeRevealed && selectedAgent && selectedCompany && (() => {
                const agentName = selectedAgent.name;
                const companyName = selectedCompany.name;
                const missionLine = missionText
                  ? ` — your mission is "${missionText}".`
                  : ".";
                const welcomeBody =
                  `Welcome to **${companyName}**! I'm ${agentName}. I've read through what you shared in the wizard${missionLine}\n\n` +
                  `Here are a few things I can help you put on paper right now. Pick one below and I'll draft it for you using everything you told us.`;

                const userHasReplied = sortedComments.some(
                  (c) => !c.authorAgentId,
                );

                const chips: Array<{ label: string; prompt: string }> = [
                  {
                    label: "Draft a Company Brief",
                    prompt: `Draft a one-page Company Brief for ${companyName} — include our mission, team roster, and first priorities.`,
                  },
                  {
                    label: "Create a hiring plan",
                    prompt: `Create a hiring plan for ${companyName}. List the next roles to hire, in priority order, with a short rationale for each.`,
                  },
                  {
                    label: "Outline our first 30 days",
                    prompt: `Outline our first 30 days. Break it into weekly priorities with who owns what.`,
                  },
                  {
                    label: "Write an intro pitch",
                    prompt: `Write a short intro pitch for ${companyName} that I could reuse for investors, customers, or recruits.`,
                  },
                ];

                return (
                  <>
                    <div className="flex flex-col items-start">
                      <AgentBubbleHeader name={agentName} icon={selectedAgent.icon} />
                      <div
                        className={cn(
                          boardChatBubbleShell,
                          "bg-card border border-border text-foreground [border-radius:14px_14px_14px_4px]",
                        )}
                      >
                        <MarkdownBody className={BOARD_CHAT_MARKDOWN_CLASS}>{welcomeBody}</MarkdownBody>
                      </div>
                    </div>
                    {!userHasReplied && chipsRevealed && (
                      <div className="flex flex-wrap gap-2 pl-1">
                        {chips.map((chip) => (
                          <button
                            key={chip.label}
                            type="button"
                            onClick={() => {
                              setInput(chip.prompt);
                              composerRef.current?.focus();
                            }}
                            // design-allow(card-pattern): interactive suggestion-pill <button>, not a content card (C5a Run 3)
                            className="rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
                          >
                            {chip.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}

              {sortedComments.map((comment) => {
                const isUser = !comment.authorAgentId;
                if (isUser) {
                  return (
                    <div key={comment.id} className="flex justify-end">
                      <div
                        className={cn(
                          boardChatBubbleShell,
                          "bg-blue-600 text-white [border-radius:14px_14px_4px_14px]",
                        )}
                      >
                        {comment.body ?? ""}
                      </div>
                    </div>
                  );
                }
                // Agent bubble — name/icon header above + action row below so
                // the room speaks the same bubble language as the task thread.
                const agent = comment.authorAgentId
                  ? agentMap.get(comment.authorAgentId) ?? null
                  : selectedAgent;
                const agentName = agent?.name ?? "Assistant";
                const agentIconValue = agent?.icon ?? null;
                return (
                  <div key={comment.id} className="flex flex-col items-start">
                    <AgentBubbleHeader name={agentName} icon={agentIconValue} />
                    <div
                      className={cn(
                        boardChatBubbleShell,
                        "bg-card border border-border text-foreground [border-radius:14px_14px_14px_4px]",
                      )}
                    >
                      <MarkdownBody className={BOARD_CHAT_MARKDOWN_CLASS}>
                        {comment.body ?? ""}
                      </MarkdownBody>
                    </div>
                    <AgentBubbleActionRow
                      copyText={comment.body ?? ""}
                      dateLabel={agentBubbleDateLabel(comment.createdAt)}
                      dateTitle={formatDateTime(comment.createdAt)}
                      anchorHref={`#comment-${comment.id}`}
                    />
                  </div>
                );
              })}

              {/* Optimistic user message — shows instantly before server persists */}
              {optimisticMessage && (
                <div className="flex justify-end">
                  <div
                    className={cn(
                      boardChatBubbleShell,
                      "bg-blue-600 text-white [border-radius:14px_14px_4px_14px]",
                    )}
                  >
                    {optimisticMessage}
                  </div>
                </div>
              )}

              {/* Admission status only. Provider drafts are never rendered. */}
              {isPending ? (
                <div className="flex items-center gap-2 pl-1 text-xs text-muted-foreground">
                  <img src="/paperclip-thinking.svg" alt="" className="inline-block shrink-0" style={{ width: 14, height: 14 }} />
                  <span>
                    {closing
                      ? "Closing this issue…"
                      : "Adding this message to the issue…"}
                  </span>
                </div>
              ) : null}

              {/* Error notice — surfaced when the stream endpoint fails so
                  the message doesn't silently sit with no response. */}
              {errorText && !sending && !closing && (
                <div
                  role="alert"
                  className="flex justify-start"
                >
                  <div
                    className={cn(
                      boardChatBubbleShell,
                      "bg-destructive/10 border border-destructive/30 text-destructive [border-radius:14px_14px_14px_4px]",
                    )}
                  >
                    {errorText}
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </div>
          </div>

          {/* Jump-to-latest — shows when user is scrolled away and new content has arrived */}
          {hasNewBelow && (
            <button
              type="button"
              onClick={() => scrollToLatest("smooth")}
              aria-label="Jump to latest messages"
              // design-allow(card-pattern): floating scroll-to-bottom <button>, not a content card (C5a Run 3)
              className="absolute bottom-24 left-1/2 z-20 grid h-8 w-8 -translate-x-1/2 place-items-center rounded-full border border-border bg-card text-foreground shadow-md transition-colors duration-150 hover:bg-accent hover:border-muted-foreground/30"
            >
              <ArrowDown className="h-4 w-4" />
            </button>
          )}

          {/* Input — shared ChatComposer (PAP-95a), adopted bare: textarea + send.
               No mode chip (the room has no task lifecycle). Multiline like task
               comments (PAP-116): text soft-wraps and the box auto-grows instead of
               clipping / showing a horizontal scrollbar. Sends on plain Enter today
               (Shift+Enter for a newline); flipping to ⌘/Ctrl+Enter is pending board
               confirmation.

               PAP-131 (PAP-128 A): the dock floats over the message stream so text
               scrolls behind the translucent glass box. The old hard black gradient
               mask is gone — the dock carries the task-style soft top fade instead
               (mirrors IssueChatThread's composer dock). pointer-events pass through
               the fade so the scrollbar stays usable; the composer re-enables them. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-background via-background/95 to-background/0 px-6 pt-6 pb-5">
            <ChatComposer
              ref={composerRef}
              value={input}
              onChange={setInput}
              onSubmit={handleSend}
              placeholder={
                boardIssueTerminal
                  ? "This issue is closed. Start a new chat to continue."
                  : "Ask anything about your company..."
              }
              submitKey="enter"
              surface="translucent"
              submitting={isPending}
              disabled={
                isPending || !selectedAgent || boardIssueTerminal
              }
              sendLabel="Send message"
              className="pointer-events-auto"
            />
          </div>
        </div>

        {/* Resize handle — hidden on mobile */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize board chat and agent feed"
          className="group relative hidden w-3 shrink-0 cursor-col-resize bg-background md:flex"
          onMouseDown={handleSplitDragStart}
        >
          <div
            className="pointer-events-none absolute top-0 bottom-0 left-0 w-px bg-border transition-colors group-hover:bg-foreground/20"
            aria-hidden
          />
        </div>

        {/* Right: Agent Feed — hidden on mobile */}
        <div className="hidden md:flex md:min-h-0 md:min-w-0 md:flex-1">
          <ActivityFeed />
        </div>
      </div>

      {/* Mobile: floating feed toggle + sheet drawer */}
      <div className="md:hidden">
        <Sheet open={mobileFeedOpen} onOpenChange={setMobileFeedOpen}>
          <SheetTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="secondary"
              className="fixed bottom-20 right-4 z-20 h-10 w-10 rounded-full shadow-lg"
              aria-label="Open agent feed"
            >
              <Activity className="h-4 w-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="h-(--sz-70vh) p-0 rounded-t-xl">
            <SheetTitle className="sr-only">Agent feed</SheetTitle>
            <ActivityFeed />
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}
