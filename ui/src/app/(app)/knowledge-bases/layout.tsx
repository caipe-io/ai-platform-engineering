"use client";

import { AuthGuard } from "@/components/auth-guard";
import { WorkspacePageHeader } from "@/components/layout/WorkspacePageHeader";
import { WorkspaceShell } from "@/components/layout/WorkspaceShell";
import {
  KNOWLEDGE_NAV_ITEMS,
  KnowledgeSidebar,
  knowledgeTabForPath,
} from "@/components/rag/KnowledgeSidebar";
import { Button } from "@/components/ui/button";
import { useRAGHealth } from "@/hooks/use-rag-health";
import { config } from "@/lib/config";
import { RefreshCw,WifiOff } from "lucide-react";
import { notFound,usePathname } from "next/navigation";
import React from "react";

function KnowledgeBasesHeader({
  description,
  href,
  title,
}: {
  description: string;
  href: string;
  title: string;
}): React.ReactElement {
  return (
    <WorkspacePageHeader
      breadcrumbs={[
        { label: "Home",href: "/" },
        { label: "Knowledge Bases",href: "/knowledge-bases/search" },
        { label: title,href },
      ]}
      description={description}
      title={title}
    />
  );
}

function KnowledgeBasesLayoutContent({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  // Use the shared RAG health hook
  const { status: ragHealth, graphRagEnabled, checkNow: checkRagHealth } = useRAGHealth();
  const activeTab = knowledgeTabForPath(pathname);
  const activeItem = KNOWLEDGE_NAV_ITEMS.find((item) => item.id === activeTab)
    ?? KNOWLEDGE_NAV_ITEMS[0];
  const graphAvailable = ragHealth === "connected" && graphRagEnabled;
  const pageDescriptions: Record<string,string> = {
    collections: "Group data sources once, then assign and update them together.",
    graph: "Explore entities and relationships across your knowledge sources.",
    ingest: "Ingest and manage the sources available to knowledge retrieval.",
    "mcp-tools": "Configure the knowledge search tools exposed through MCP.",
    search: "Search and explore your approved knowledge bases.",
  };

  // Disconnected state
  if (ragHealth === "disconnected") {
    return (
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full w-full max-w-none flex-col px-4 pb-6 pt-3 sm:px-6 lg:pb-8">
          <KnowledgeBasesHeader
            description={pageDescriptions[activeItem.id]}
            href={activeItem.href ?? "/knowledge-bases/search"}
            title={activeItem.label}
          />
          <div className="flex flex-1 flex-col items-center justify-center p-4 text-center text-muted-foreground">
          <WifiOff className="h-16 w-16 mb-4 text-destructive" />
          <h2 className="text-2xl font-bold mb-2 text-foreground">RAG Server Unavailable</h2>
          <p className="text-lg mb-4">
            Unable to connect to the RAG server at{" "}
            <span className="font-mono text-sm text-foreground">{config.ragUrl}</span>
          </p>
          <Button
            onClick={checkRagHealth}
            className="mt-4 flex items-center gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Retry Connection
          </Button>
          </div>
        </div>
      </main>
    );
  }

  if (activeTab === "graph" && ragHealth === "connected" && !graphRagEnabled) {
    notFound();
  }

  // Connected workspaces share the same responsive rail and contextual header.
  return (
    <WorkspaceShell
      className="xl:overflow-hidden"
      containerClassName="min-h-full xl:h-full"
      contentClassName="flex min-h-[42rem] flex-col overflow-hidden xl:min-h-0"
      header={(
        <KnowledgeBasesHeader
          description={pageDescriptions[activeItem.id]}
          href={activeItem.href ?? "/knowledge-bases/search"}
          title={activeItem.label}
        />
      )}
      navigation={<KnowledgeSidebar graphRagEnabled={graphAvailable} />}
      navigationAreaKey="knowledge"
      navigationVersion={`${activeTab}:${graphAvailable}`}
    >
      {children}
    </WorkspaceShell>
  );
}

export default function KnowledgeBasesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <KnowledgeBasesLayoutContent>
        {children}
      </KnowledgeBasesLayoutContent>
    </AuthGuard>
  );
}
