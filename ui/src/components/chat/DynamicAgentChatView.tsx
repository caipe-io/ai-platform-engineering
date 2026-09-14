"use client";

import { ChatPanel } from "@/components/chat/DynamicAgentChatPanel";
import { DynamicAgentContext } from "@/components/dynamic-agents/DynamicAgentContext";
import { ResizableHandle,ResizablePanel,ResizablePanelGroup } from "@/components/ui/resizable";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import { useCallback,useState } from "react";
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
  /** Whether the chat is read-only */
  readOnly?: boolean;
  /** Reason for read-only mode */
  readOnlyReason?: "admin_audit" | "shared_readonly";
  /** Whether messages are still loading (show skeleton) */
  isLoadingMessages?: boolean;
  /** Called after a deprecated conversation is linked to a usable agent. */
  onAgentRelinked?: (agentId: string) => void;
}

/**
 * Chat view for Dynamic Agents.
 * Combines ChatPanel with a resizable DynamicAgentContext panel.
 */
export function ChatView({
  conversationId,
  selectedAgentId,
  agent,
  agentNotFound,
  readOnly,
  readOnlyReason,
  isLoadingMessages,
  onAgentRelinked,
}: ChatViewProps) {
  const [contextPanelCollapsed, setContextPanelCollapsed] = useState(true);
  const [isAnimating, setIsAnimating] = useState(false);
  const contextPanelRef = usePanelRef();

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

  const isDisabled = agentNotFound || agent?.enabled === false;

  return (
    <ResizablePanelGroup
      direction="horizontal"
      className="flex-1 min-w-0 h-full"
      data-animating={isAnimating || undefined}
    >
      {/* Chat Panel */}
      <ResizablePanel minSize={40}>
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden h-full">
          <ChatPanel
            conversationId={conversationId}
            readOnly={readOnly || isDisabled}
            readOnlyReason={agentNotFound ? 'agent_deleted' : agent?.enabled === false ? 'agent_disabled' : readOnlyReason}
            agentId={selectedAgentId}
            agent={agent}
            isLoadingMessages={isLoadingMessages}
            onAgentRelinked={onAgentRelinked}
          />
        </div>
      </ResizablePanel>

      <ResizableHandle />

      {/* Context Panel - Dynamic Agent variant */}
      <ResizablePanel
        panelRef={contextPanelRef}
        defaultSize="64px"
        minSize="340px"
        maxSize="70%"
        collapsible
        collapsedSize="64px"
        onResize={(size) => {
          setContextPanelCollapsed(size.inPixels <= 80);
        }}
      >
        <DynamicAgentContext
          conversationId={conversationId}
          agentId={selectedAgentId}
          agent={agent}
          agentNotFound={agentNotFound}
          collapsed={contextPanelCollapsed}
          onCollapse={handleCollapse}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
