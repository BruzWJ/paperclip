import { useEffect } from "react";
import {
  focusPageSearchShortcutTarget,
  hasBlockingShortcutDialog,
  isKeyboardShortcutTextInputTarget,
  resolveTaskDetailGoKeyAction,
} from "../lib/keyboardShortcuts";

interface ShortcutHandlers {
  enabled?: boolean;
  onNewTask?: () => void;
  onSearch?: () => void;
  onToggleSidebar?: () => void;
  onTogglePanel?: () => void;
  onShowShortcuts?: () => void;
  onGoToInbox?: () => void;
}

export function useKeyboardShortcuts({
  enabled = true,
  onNewTask,
  onSearch,
  onToggleSidebar,
  onTogglePanel,
  onShowShortcuts,
  onGoToInbox,
}: ShortcutHandlers) {
  useEffect(() => {
    if (!enabled) return;

    // g → i chord state. TaskDetail runs its own capture-phase handler with
    // an extra comment-focus chord and stops propagation when it handles it, so
    // this bubble-phase chord only fires outside the task detail page.
    let goChordArmed = false;
    let goChordTimeout: number | null = null;
    const clearGoChordTimeout = () => {
      if (goChordTimeout !== null) {
        window.clearTimeout(goChordTimeout);
        goChordTimeout = null;
      }
    };
    const disarmGoChord = () => {
      goChordArmed = false;
      clearGoChordTimeout();
    };
    const armGoChord = () => {
      goChordArmed = true;
      clearGoChordTimeout();
      goChordTimeout = window.setTimeout(() => {
        goChordArmed = false;
        goChordTimeout = null;
      }, 1200);
    };

    function handleKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) {
        disarmGoChord();
        return;
      }

      if (onGoToInbox) {
        const chordAction = resolveTaskDetailGoKeyAction({
          armed: goChordArmed,
          defaultPrevented: e.defaultPrevented,
          key: e.key,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          target: e.target,
          hasOpenDialog: hasBlockingShortcutDialog(),
        });
        if (chordAction === "arm") {
          armGoChord();
          return;
        }
        if (chordAction === "navigate_inbox") {
          disarmGoChord();
          e.preventDefault();
          onGoToInbox();
          return;
        }
        if (chordAction === "focus_comment") {
          // Swallow task-detail-only chord keys so they do not trigger bare
          // shortcuts.
          disarmGoChord();
          e.preventDefault();
          return;
        }
        if (chordAction === "disarm") disarmGoChord();
      }

      // Don't fire shortcuts when typing in inputs
      if (isKeyboardShortcutTextInputTarget(e.target)) {
        return;
      }

      // / → Page search when available, otherwise quick search
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (hasBlockingShortcutDialog()) {
          return;
        }

        e.preventDefault();
        if (!focusPageSearchShortcutTarget()) {
          onSearch?.();
        }
        return;
      }

      // ? → Show keyboard shortcuts cheatsheet
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onShowShortcuts?.();
        return;
      }

      // C → New Task
      if (e.key === "c" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onNewTask?.();
      }

      // [ → Toggle Sidebar
      if (e.key === "[" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onToggleSidebar?.();
      }

      // ] → Toggle Panel
      if (e.key === "]" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onTogglePanel?.();
      }
    }

    const handlePointerDown = () => disarmGoChord();
    const handleFocusIn = (e: FocusEvent) => {
      if (e.target instanceof HTMLElement && e.target !== document.body) disarmGoChord();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      disarmGoChord();
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [enabled, onNewTask, onSearch, onToggleSidebar, onTogglePanel, onShowShortcuts, onGoToInbox]);
}
