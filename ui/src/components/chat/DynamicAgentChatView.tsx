"use client";

import { ChatPanel } from "@/components/chat/DynamicAgentChatPanel";
import { useAppAssistantPresentation, useAssistantComposerOptions } from "@/components/agentic-apps/AssistantComposerOptions";
import { DynamicAgentContext } from "@/components/dynamic-agents/DynamicAgentContext";
import { ResizableHandle,ResizablePanel,ResizablePanelGroup } from "@/components/ui/resizable";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import { useCallback,useState,useSyncExternalStore } from "react";
import { usePanelRef } from "react-resizable-panels";

interface ChatViewProps {
  /** MongoDB conversation UUID */
  conversationId: string;
  /** The selected dynamic agent ID */
  selectedAgentId: string;
  /** Full agent config (null while loading) */
  agent?: DynamicAgentConfig | null;
  /** Whether the agent has been deleted */
  agentNotFound?: boolean;
  /** Metadata may be hidden from a shared viewer; this does not prove deletion. */
  agentUnavailable?: boolean;
  /** Whether the chat is read-only */
  readOnly?: boolean;
  /** Reason for read-only mode */
  readOnlyReason?: "admin_audit" | "shared_readonly";
  /** Whether this conversation is also used by an API client. */
  apiConversation?: boolean;
  /** Whether messages are still loading (show skeleton) */
  isLoadingMessages?: boolean;
}

const narrowQuery = "(max-width: 767px)";
function subscribeToViewport(onChange: () => void): () => void {
  const query = window.matchMedia(narrowQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const isNarrowViewport = () => window.matchMedia(narrowQuery).matches;
const serverViewport = () => false;

/**
 * Chat view for Dynamic Agents.
 * Combines ChatPanel with a resizable DynamicAgentContext panel.
 */
export function ChatView({
  conversationId,
  selectedAgentId,
  agent,
  agentNotFound,
  agentUnavailable,
  readOnly,
  readOnlyReason,
  apiConversation,
  isLoadingMessages,
}: ChatViewProps) {
  const [contextPanelCollapsed, setContextPanelCollapsed] = useState(true);
  const narrow = useSyncExternalStore(subscribeToViewport, isNarrowViewport, serverViewport);
  const [isAnimating, setIsAnimating] = useState(false);
  const contextPanelRef = usePanelRef();
  const { app, configuration } = useAppAssistantPresentation(agent?.presentation?.available ? agent.presentation.app.id : undefined, selectedAgentId);
  const options = app?.assistantOptions;
  const { requestOptions, composerHeader } = useAssistantComposerOptions(options, configuration, app?.appId);
  const assistantLabel = app ? app.assistantLabel?.trim() || "Ask CAIPE" : undefined;

  const handleCollapse = useCallback((collapsed: boolean) => {
    // Enable transition for programmatic expand/collapse, disable after animation
    setIsAnimating(true);
    if (collapsed) {
      contextPanelRef.current?.collapse();
    } else {
      contextPanelRef.current?.expand();
    }
    // Remove transition after animation completes so dragging isn't laggy
    setTimeout(() => setIsAnimating(false), 300);
  }, [contextPanelRef]);

  const isDisabled = agentNotFound || agentUnavailable || agent?.enabled === false;

  return (
    <ResizablePanelGroup
      direction={narrow ? "vertical" : "horizontal"}
      className="flex-1 min-w-0 h-full"
      data-animating={isAnimating || undefined}
    >
      {/* Chat Panel */}
      <ResizablePanel minSize={40}>
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden h-full">
          <ChatPanel
            conversationId={conversationId}
            readOnly={readOnly || isDisabled}
            readOnlyReason={readOnlyReason ?? (agentUnavailable ? 'agent_unavailable' : agentNotFound ? 'agent_deleted' : agent?.enabled === false ? 'agent_disabled' : undefined)}
            apiConversation={apiConversation}
            agentId={selectedAgentId}
            agent={agent}
            isLoadingMessages={isLoadingMessages}
            requestOptions={app ? requestOptions : undefined}
            composerHeader={composerHeader}
            placeholder={options?.presentation?.placeholder ?? (assistantLabel ? `${assistantLabel}…` : undefined)}
            emptyStateTitle={assistantLabel}
            showAuditNotice={options?.presentation?.showAuditNotice}
            feedbackPrompt={options?.presentation?.feedbackPrompt}
          />
        </div>
      </ResizablePanel>
      <ResizableHandle className="bg-transparent hover:bg-primary/40 focus-visible:bg-primary/40" />
      {/* Workspace stays to the right of chat (below it on narrow screens). */}
      <ResizablePanel
        panelRef={contextPanelRef}
        defaultSize="48px"
        minSize={narrow ? "160px" : "280px"}
        maxSize={narrow ? "55%" : "45%"}
        collapsible
        collapsedSize="48px"
        groupResizeBehavior="preserve-pixel-size"
        onResize={() => setContextPanelCollapsed(contextPanelRef.current?.isCollapsed() ?? true)}
      >
        <DynamicAgentContext
          key={`${selectedAgentId}:${conversationId}`}
          conversationId={conversationId}
          agentId={selectedAgentId}
          agent={agent}
          agentNotFound={agentNotFound}
          collapsed={contextPanelCollapsed}
          onCollapse={handleCollapse}
          readOnly={readOnly || isDisabled}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
