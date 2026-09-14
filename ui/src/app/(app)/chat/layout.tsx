"use client";

import { AuthGuard } from "@/components/auth-guard";
import { ChatContainer } from "@/components/chat/ChatContainer";
import { Sidebar } from "@/components/layout/Sidebar";
import { WorkspaceBreadcrumbs } from "@/components/layout/WorkspacePageHeader";
import { useParams } from "next/navigation";
import React,{ useState } from "react";

/**
 * Chat layout — renders the Sidebar and ChatContainer once and persists them
 * across route changes. This prevents visual flicker when navigating between
 * conversations.
 * 
 * The ChatContainer handles rendering the appropriate chat view (Dynamic Agent
 * or Platform Engineer) based on the current conversation. It reads the uuid
 * from useParams() and manages all chat state internally.
 * 
 * The children (page.tsx content) is only used for the /chat redirect page.
 * For /chat/[uuid] routes, children is null and ChatContainer renders the chat.
 */
export default function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Check if we're on a specific conversation route
  const hasUuid = !!params?.uuid;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <WorkspaceBreadcrumbs
        breadcrumbs={[
          { label: "Home",href: "/" },
          { label: "Chat",href: hasUuid ? `/chat/${String(params.uuid)}` : "/chat" },
        ]}
      />

      <div className="flex min-h-0 flex-1">
        {/* Sidebar - persists across conversation changes */}
        <Sidebar
          activeTab="chat"
          collapsed={sidebarCollapsed}
          onCollapse={setSidebarCollapsed}
        />

        {/* Chat content - ChatContainer persists, children used only for /chat redirect */}
        <div className="flex min-w-0 flex-1">
          {hasUuid ? <AuthGuard><ChatContainer /></AuthGuard> : children}
        </div>
      </div>
    </div>
  );
}
