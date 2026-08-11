import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { accessApi } from "../api/access";
import { queryKeys } from "@/lib/queryKeys";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Bot, Check, MailPlus, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildAgentOnboardingPrompt } from "@/lib/agent-onboarding-prompt";
import { useToast } from "../context/ToastContext";

type NewAgentDialogMode = "choices" | "invite" | "prompt";

export function NewAgentDialog() {
  const { newAgentOpen, closeNewAgent, openNewTask } = useDialog();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<NewAgentDialogMode>("choices");
  const [agentMessage, setAgentMessage] = useState("");
  const [latestAgentPrompt, setLatestAgentPrompt] = useState<string | null>(null);
  const [latestAgentPromptCopied, setLatestAgentPromptCopied] = useState(false);

  function resetDialogState() {
    setMode("choices");
    setAgentMessage("");
    setLatestAgentPrompt(null);
    setLatestAgentPromptCopied(false);
  }

  useEffect(() => {
    if (!latestAgentPromptCopied) return;
    const timeout = window.setTimeout(() => {
      setLatestAgentPromptCopied(false);
    }, 1600);
    return () => window.clearTimeout(timeout);
  }, [latestAgentPromptCopied]);

  const inviteHistoryQueryKey = queryKeys.access.invites(selectedCompanyId ?? "", "all", 5);

  function handleAskAgent() {
    closeNewAgent();
    openNewTask({
      title: "Create a new agent",
      request: "(type in what kind of agent you want here)",
    });
  }

  function handleAdvancedConfig() {
    closeNewAgent();
    resetDialogState();
    navigate("/agents/new");
  }

  function handleInviteExternalAgent() {
    setMode("invite");
  }

  async function copyText(text: string, unavailableBody: string) {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fall through to the unavailable message below.
    }

    pushToast({
      title: "Clipboard unavailable",
      body: unavailableBody,
      tone: "warn",
    });
    return false;
  }

  const createAgentInviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createCompanyInvite(selectedCompanyId!, {
        allowedJoinTypes: "agent",
        humanRole: null,
        agentMessage: agentMessage.trim() || null,
      }),
    onSuccess: async (invite) => {
      const prompt = buildAgentOnboardingPrompt({
        onboardingTextUrl: invite.onboardingTextUrl,
      });

      setLatestAgentPrompt(prompt);
      setLatestAgentPromptCopied(false);
      setMode("prompt");
      const copied = await copyText(prompt, "Copy the agent onboarding prompt manually from the field below.");

      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({
        title: "Agent invite created",
        body: copied ? "Agent onboarding prompt ready below and copied to clipboard." : "Agent onboarding prompt ready below.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to create agent invite",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  return (
    <Dialog
      open={newAgentOpen}
      onOpenChange={(open) => {
        if (!open) {
          resetDialogState();
          closeNewAgent();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn(
          "max-h-(--sz-calc-16) p-0 gap-0 overflow-hidden flex flex-col",
          mode === "invite" || mode === "prompt" ? "sm:max-w-2xl" : "sm:max-w-md",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <DialogTitle className="text-sm font-normal text-muted-foreground">
            Add a new agent
          </DialogTitle>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            onClick={() => {
              resetDialogState();
              closeNewAgent();
            }}
          >
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        <div className="min-h-0 overflow-y-auto p-6 space-y-6">
          {mode === "choices" ? (
            <>
              {/* Recommendation */}
              <div className="text-center space-y-3">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent">
                  <Bot className="h-6 w-6 text-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  Ask a leader to propose the hire, configure a runtime yourself,
                  or send an onboarding prompt to an external agent.
                </p>
              </div>

              <Button className="w-full" size="lg" onClick={handleAskAgent}>
                <Bot data-icon="inline-start" className="h-4 w-4 mr-2" />
                Ask an agent to create a new agent
              </Button>

              <div className="grid gap-2">
                <Button variant="outline" className="w-full" onClick={handleAdvancedConfig}>
                  <Settings2 data-icon="inline-start" className="h-4 w-4 mr-2" />
                  Configure a runtime manually
                </Button>
                <div className="space-y-1">
                  <Button variant="outline" className="w-full" onClick={handleInviteExternalAgent}>
                    <MailPlus data-icon="inline-start" className="h-4 w-4 mr-2" />
                    Invite an external agent
                  </Button>
                  <p className="text-xs text-muted-foreground text-center">
                    The invite submits a configuration proposal; Paperclip&apos;s worker executes the approved adapter.
                  </p>
                </div>
              </div>
            </>
          ) : mode === "invite" ? (
            <div className="space-y-5">
              <div className="space-y-2">
                <button
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setMode("choices")}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </button>
                <div className="space-y-1">
                  <h2 className="text-sm font-semibold">Invite an external agent</h2>
                  <p className="text-sm text-muted-foreground">
                    Generate a one-time prompt that an external agent can use to propose an ordinary Paperclip agent configuration for board approval.
                  </p>
                </div>
              </div>

              <label className="block space-y-2">
                <span className="text-sm font-medium">Optional message for the agent</span>
                <Textarea
                  value={agentMessage}
                  onChange={(event) => setAgentMessage(event.target.value)}
                  className="min-h-24 resize-y"
                  placeholder="Add onboarding context, expected responsibilities, or first instructions."
                  maxLength={4000}
                />
              </label>

              <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
                Agent invites create a configuration proposal. A company admin chooses the final adapter and execution configuration before creating the agent; no generic Paperclip API key is granted.
              </div>

              <div>
                <Button
                  onClick={() => createAgentInviteMutation.mutate()}
                  disabled={!selectedCompanyId || createAgentInviteMutation.isPending}
                >
                  {createAgentInviteMutation.isPending ? "Generating…" : "Generate onboarding prompt"}
                </Button>
                {createAgentInviteMutation.isPending ? (
                  <p role="status" className="mt-2 text-xs text-muted-foreground">
                    Generating onboarding prompt…
                  </p>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="space-y-2">
                <button
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setMode("invite")}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </button>
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold">Agent onboarding prompt</h2>
                    {latestAgentPromptCopied ? (
                      <div className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                        <Check className="h-3.5 w-3.5" />
                        Copied
                      </div>
                    ) : null}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Send this prompt to the external agent that should propose the new Paperclip agent configuration.
                  </p>
                </div>
              </div>

              <Textarea
                readOnly
                value={latestAgentPrompt ?? ""}
                aria-label="Agent onboarding prompt"
                className="h-(--sz-24rem) resize-y font-mono text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!latestAgentPrompt}
                onClick={async () => {
                  if (!latestAgentPrompt) return;
                  const copied = await copyText(latestAgentPrompt, "Copy the agent onboarding prompt manually from the field above.");
                  setLatestAgentPromptCopied(copied);
                }}
              >
                {latestAgentPromptCopied ? "Copied prompt" : "Copy prompt"}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
