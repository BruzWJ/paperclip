import { useNavigate } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useDialog } from "../context/DialogContext";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Bot, Settings2 } from "lucide-react";

export function NewAgentDialog() {
  const { newAgentOpen, closeNewAgent, openNewTask } = useDialog();
  const navigate = useNavigate();
  const companyId = useCompanyRouteId();

  function handleAskAgent() {
    closeNewAgent();
    openNewTask({
      title: "Create a new agent",
      request: "(type in what kind of agent you want here)",
    });
  }

  function handleAdvancedConfig() {
    closeNewAgent();
    void navigate({
      to: "/$companyId/agents/new",
      params: { companyId },
    });
  }

  return (
    <Dialog
      open={newAgentOpen}
      onOpenChange={(open) => !open && closeNewAgent()}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-(--sz-calc-16) p-0 gap-0 overflow-hidden flex flex-col sm:max-w-md"
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <DialogTitle className="text-sm font-normal text-muted-foreground">
            Add a new agent
          </DialogTitle>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            onClick={closeNewAgent}
          >
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        <div className="min-h-0 overflow-y-auto p-6 space-y-6">
          <div className="text-center space-y-3">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent">
              <Bot className="h-6 w-6 text-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">
              Ask a leader to propose the hire or configure an ACPX runtime
              yourself.
            </p>
          </div>

          <Button className="w-full" size="lg" onClick={handleAskAgent}>
            <Bot data-icon="inline-start" className="h-4 w-4 mr-2" />
            Ask an agent to create a new agent
          </Button>

          <Button
            variant="outline"
            className="w-full"
            onClick={handleAdvancedConfig}
          >
            <Settings2 data-icon="inline-start" className="h-4 w-4 mr-2" />
            Configure an ACPX runtime manually
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
