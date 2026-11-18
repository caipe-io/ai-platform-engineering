import { Button } from "@/components/ui/button";
import { ArrowRight, Sparkles, Unplug } from "lucide-react";

export function AddAgentChoices({
  onCreate,
  onConnect,
  canConnect,
}: {
  onCreate: () => void;
  onConnect: () => void;
  canConnect: boolean;
}) {
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <Button
        type="button"
        variant="outline"
        className="h-auto min-w-0 flex-col items-start gap-4 whitespace-normal p-5 text-left"
        onClick={onCreate}
      >
        <Sparkles aria-hidden="true" className="text-primary" />
        <span>
          <span className="block font-semibold">Create CAIPE agent</span>
          <span className="mt-2 block font-normal text-muted-foreground">
            Define instructions, choose a model, and add tools.
          </span>
        </span>
        <span className="mt-auto flex items-center gap-2 text-xs text-primary">
          Open Agent Builder <ArrowRight aria-hidden="true" />
        </span>
      </Button>
      <Button
        type="button"
        variant="outline"
        className="h-auto min-w-0 flex-col items-start gap-4 whitespace-normal p-5 text-left"
        onClick={onConnect}
        disabled={!canConnect}
        aria-describedby={!canConnect ? "connect-agent-permission" : undefined}
      >
        <Unplug aria-hidden="true" className="text-primary" />
        <span>
          <span className="block font-semibold">Connect existing agent</span>
          <span className="mt-2 block font-normal text-muted-foreground">
            Use an agent URL or discover agents in Kubernetes.
          </span>
        </span>
        <span className="mt-auto flex items-center gap-2 text-xs text-primary">
          Find and connect <ArrowRight aria-hidden="true" />
        </span>
      </Button>
      {!canConnect && (
        <p id="connect-agent-permission" className="text-sm text-muted-foreground sm:col-span-2">
          Registry management access is required to connect an existing agent.
        </p>
      )}
    </div>
  );
}
