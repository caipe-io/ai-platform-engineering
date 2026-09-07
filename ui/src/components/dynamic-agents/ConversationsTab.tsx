"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WorkspacePageActions } from "@/components/layout/WorkspacePageActions";
import { Card,CardContent } from "@/components/ui/card";
import {
Dialog,
DialogContent,
DialogHeader,
DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { AgentPicker, type AgentPickerOption } from "@/components/ui/agent-picker";
import { useToast } from "@/components/ui/toast";
import { loadAllDynamicAgents } from "@/lib/dynamic-agent-list";
import type { AgentUIConfig } from "@/types/dynamic-agent";
import {
AlertCircle,
Archive,
Bot,
ChevronLeft,
ChevronRight,
Clock,
Copy,
ExternalLink,
FileText,
Globe,
Hash,
Loader2,
MessageSquare,
RefreshCw,
Search,
Trash2,
User,
} from "lucide-react";
import React from "react";
import { AgentAvatar } from "./AgentAvatar";

interface ConversationItem {
  id: string;
  title: string;
  owner_id: string;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
  checkpoint_count: number;
  file_count?: number;
  message_count?: number;
  client_type?: string;
  idempotency_key?: string;
  metadata?: {
    thread_ts?: string;
    channel_id?: string;
    channel_name?: string;
    workspace_url?: string;
    [key: string]: unknown;
  };
  is_archived: boolean;
  deleted_at: string | null;
}

interface AgentInfo {
  _id: string;
  name: string;
  ui?: AgentUIConfig;
}

interface PaginatedResponse {
  items: ConversationItem[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

export function ConversationsTab() {
  const [conversations, setConversations] = React.useState<ConversationItem[]>([]);
  const [agents, setAgents] = React.useState<Map<string, AgentInfo>>(new Map());
  const [agentsList, setAgentsList] = React.useState<AgentInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [searchInput, setSearchInput] = React.useState("");
  const [agentFilter, setAgentFilter] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(10);
  const [totalPages, setTotalPages] = React.useState(1);
  const [total, setTotal] = React.useState(0);
  const [clearingId, setClearingId] = React.useState<string | null>(null);
  const [selectedConversation, setSelectedConversation] = React.useState<ConversationItem | null>(null);
  const { toast } = useToast();

  // Fetch agents once on mount to build lookup map
  React.useEffect(() => {
    async function fetchAgents() {
      try {
        const items = await loadAllDynamicAgents<AgentInfo>();
        const agentMap = new Map<string, AgentInfo>();
        for (const agent of items) agentMap.set(agent._id, agent);
        setAgents(agentMap);
        setAgentsList(items);
      } catch {
        // Silently fail - we'll just show agent IDs
      }
    }
    fetchAgents();
  }, []);

  const agentOptions = React.useMemo<AgentPickerOption[]>(
    () => agentsList.map((agent) => ({ value: agent._id, label: agent.name })),
    [agentsList],
  );

  const fetchConversations = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        page_size: pageSize.toString(),
      });
      if (search.trim()) {
        params.set("search", search.trim());
      }
      if (agentFilter) {
        params.set("agent_id", agentFilter);
      }

      const response = await fetch(`/api/dynamic-agents/conversations?${params}`);
      const data = await response.json();

      if (data.success && data.data) {
        const paginated = data.data as PaginatedResponse;
        setConversations(paginated.items || []);
        setTotalPages(Math.ceil((paginated.total || 0) / (paginated.page_size || pageSize)));
        setTotal(paginated.total || 0);
      } else {
        setError(data.error || "Failed to fetch conversations");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to fetch conversations";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, search, agentFilter]);

  React.useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // Debounce search input — update query value after 300ms of no typing
  React.useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput !== search) {
        setSearch(searchInput);
        setPage(1);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, search]);

  const getAgentName = (agentId: string | null): string => {
    if (!agentId) return "Unknown";
    const agent = agents.get(agentId);
    return agent?.name || agentId;
  };

  const handleClear = async (conversationId: string) => {
    if (!confirm("Are you sure you want to delete all data for this conversation? This will permanently remove the conversation, messages, checkpoints, and stored files.")) {
      return;
    }

    setClearingId(conversationId);
    try {
      const response = await fetch(`/api/admin/audit-logs/${encodeURIComponent(conversationId)}`, {
        method: "DELETE",
      });
      const data = await response.json();

      if (data.success) {
        toast("Conversation deleted successfully", "success");
        fetchConversations();
      } else {
        toast(data.error || "Failed to delete conversation", "error");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to delete conversation";
      toast(message, "error");
    } finally {
      setClearingId(null);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput);
    setPage(1);
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const buildSlackPermalink = (conv: ConversationItem): string | null => {
    const meta = conv.metadata;
    if (!meta?.workspace_url || !meta?.channel_id || !meta?.thread_ts) return null;
    const tsClean = meta.thread_ts.replace(".", "");
    return `${meta.workspace_url}/archives/${meta.channel_id}/p${tsClean}`;
  };

  return (
    <>
      <WorkspacePageActions>
        <Button variant="outline" size="sm" onClick={fetchConversations} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </WorkspacePageActions>
      <Card className="rounded-none border-0 bg-transparent shadow-none">
        <CardContent className="px-0 pt-0">
        {/* Search and Filters */}
        <div className="flex items-center gap-4 mb-4">
          <form onSubmit={handleSearch} className="flex-1 flex gap-2">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by ID, title, or owner..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="pl-10"
              />
            </div>
            <AgentPicker
              ariaLabel="Filter conversations by agent"
              value={agentFilter}
              onChange={(agentId) => {
                setAgentFilter(agentId);
                setPage(1);
              }}
              options={agentOptions}
              placeholder="All agents"
              searchPlaceholder="Search agents..."
              emptyLabel="No agents match"
              triggerClassName="h-9 min-w-56 py-1"
            />
            <Button type="submit" variant="secondary" size="sm">
              Search
            </Button>
          </form>
        </div>

        {/* Results count */}
        <div className="text-sm text-muted-foreground mb-4">
          {total} conversation{total !== 1 ? "s" : ""} found
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="text-center py-12">
            <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
            <p className="text-destructive">{error}</p>
            <Button variant="outline" className="mt-4" onClick={fetchConversations}>
              Retry
            </Button>
          </div>
        ) : conversations.length === 0 ? (
          <div className="text-center py-12">
            <MessageSquare className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Conversations Found</h3>
            <p className="text-muted-foreground">
              {search ? "No conversations match your search criteria." : "No conversations have been created yet."}
            </p>
          </div>
        ) : (
          <>
            {/* Table */}
            <div className="space-y-3">
              {/* Header */}
              <div className="grid grid-cols-12 gap-4 pb-2 border-b text-xs font-medium text-muted-foreground px-2">
                <div className="col-span-4">Conversation</div>
                <div className="col-span-2">Owner</div>
                <div className="col-span-2">Agent</div>
                <div className="col-span-1">Checkpoints</div>
                <div className="col-span-1">Status</div>
                <div className="col-span-1">Updated</div>
                <div className="col-span-1 text-right">Actions</div>
              </div>

              {/* Rows */}
              {conversations.map((conv) => (
                <div
                  key={conv.id}
                  className={`grid grid-cols-12 gap-4 py-3 px-2 rounded-lg hover:bg-muted/50 items-center cursor-pointer ${
                    conv.deleted_at ? "opacity-60" : ""
                  }`}
                  onClick={() => setSelectedConversation(conv)}
                >
                  <div className="col-span-4">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
                        <MessageSquare className="h-5 w-5 text-blue-500" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-sm truncate">{conv.title}</div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <Badge
                            variant="outline"
                            className={`text-[10px] px-1.5 py-0 leading-4 ${
                              conv.client_type === "slack"
                                ? "text-purple-600 border-purple-300"
                                : "text-blue-600 border-blue-300"
                            }`}
                          >
                            {conv.client_type === "slack" ? "Slack" : "Web"}
                          </Badge>
                          <span className="text-xs text-muted-foreground font-mono truncate">
                            {conv.id}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="col-span-2">
                    <div className="flex items-center gap-1.5">
                      <User className="h-3 w-3 text-muted-foreground" />
                      <span className="text-sm truncate">{conv.owner_id}</span>
                    </div>
                  </div>

                  <div className="col-span-2">
                    <div className="flex items-center gap-1.5">
                      <AgentAvatar
                        agent={conv.agent_id ? agents.get(conv.agent_id) : undefined}
                        rounded="rounded-full"
                        size="h-4 w-4"
                        iconSize="h-2.5 w-2.5"
                      />
                      <span className="text-sm truncate">{getAgentName(conv.agent_id)}</span>
                    </div>
                  </div>

                  <div className="col-span-1">
                    <span className="text-sm text-muted-foreground">
                      {conv.checkpoint_count}
                    </span>
                  </div>

                  <div className="col-span-1">
                    {conv.deleted_at ? (
                      <Badge variant="outline" className="gap-1 text-orange-600 border-orange-300">
                        <Archive className="h-3 w-3" />
                        Trash
                      </Badge>
                    ) : conv.is_archived ? (
                      <Badge variant="outline" className="gap-1 text-muted-foreground">
                        <Archive className="h-3 w-3" />
                        Archived
                      </Badge>
                    ) : (
                      <span className="text-sm text-green-600">Active</span>
                    )}
                  </div>

                  <div className="col-span-1">
                    <span className="text-xs text-muted-foreground">
                      {formatDate(conv.updated_at)}
                    </span>
                  </div>

                  <div className="col-span-1 flex items-center justify-end">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={(e) => { e.stopPropagation(); handleClear(conv.id); }}
                      disabled={clearingId === conv.id}
                      title="Delete all conversation data"
                    >
                      {clearingId === conv.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            {/* Pagination */}
            {total > 0 && (
              <div className="flex items-center justify-between mt-6 gap-4">
                {/* Showing X-Y of Z */}
                <span className="text-sm text-muted-foreground whitespace-nowrap">
                  Showing {Math.min((page - 1) * pageSize + 1, total)}–{Math.min(page * pageSize, total)} of {total}
                </span>

                {/* Page buttons */}
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1)
                    .filter((p) => {
                      // Show first, last, and pages near current
                      if (p === 1 || p === totalPages) return true;
                      if (Math.abs(p - page) <= 1) return true;
                      return false;
                    })
                    .reduce<(number | "ellipsis")[]>((acc, p, idx, arr) => {
                      if (idx > 0 && p - (arr[idx - 1] as number) > 1) {
                        acc.push("ellipsis");
                      }
                      acc.push(p);
                      return acc;
                    }, [])
                    .map((item, idx) =>
                      item === "ellipsis" ? (
                        <span key={`ellipsis-${idx}`} className="px-1 text-muted-foreground text-sm">...</span>
                      ) : (
                        <Button
                          key={item}
                          variant={page === item ? "default" : "outline"}
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => setPage(item)}
                        >
                          {item}
                        </Button>
                      )
                    )}
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>

                {/* Page size dropdown */}
                <div className="flex items-center gap-2">
                  <label className="text-sm text-muted-foreground whitespace-nowrap" htmlFor="conversation-page-size">Rows</label>
                  <Select
                    aria-label="Rows per page"
                    id="conversation-page-size"
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setPage(1);
                    }}
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {[10, 20, 50, 100].map((size) => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </Select>
                </div>
              </div>
            )}
          </>
        )}
        </CardContent>

      {/* Conversation Detail Modal */}
      <Dialog open={!!selectedConversation} onOpenChange={(open) => { if (!open) setSelectedConversation(null); }}>
        <DialogContent className="sm:max-w-lg">
          {selectedConversation && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <MessageSquare className="h-5 w-5 text-blue-500 shrink-0" />
                  <span className="break-words">{selectedConversation.title}</span>
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-4 pt-2">
                {/* Source badge */}
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Source</span>
                  <Badge
                    variant="outline"
                    className={
                      selectedConversation.client_type === "slack"
                        ? "text-purple-600 border-purple-300"
                        : "text-blue-600 border-blue-300"
                    }
                  >
                    {selectedConversation.client_type === "slack" ? "Slack" : "Web"}
                  </Badge>
                </div>

                {/* Slack permalink (for Slack conversations) */}
                {(() => {
                  const permalink = buildSlackPermalink(selectedConversation);
                  return permalink ? (
                    <div className="flex items-center gap-2">
                      <ExternalLink className="h-4 w-4 text-muted-foreground" />
                      <a
                        href={permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary hover:underline inline-flex items-center gap-1"
                      >
                        View Slack thread
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  ) : null;
                })()}

                {/* ID */}
                <div className="flex items-start gap-2">
                  <Hash className="h-4 w-4 text-muted-foreground mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-muted-foreground">Conversation ID</div>
                    <div className="flex items-center gap-1.5">
                      <code className="text-sm font-mono break-all">{selectedConversation.id}</code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        onClick={() => { navigator.clipboard.writeText(selectedConversation.id); toast("Copied to clipboard", "success"); }}
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Owner */}
                {selectedConversation.idempotency_key && (
                  <div className="flex items-start gap-2">
                    <Hash className="h-4 w-4 text-muted-foreground mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-muted-foreground">
                        Idempotency Key (internal chat ID for {selectedConversation.client_type === "slack" ? "Slack" : selectedConversation.client_type || "unknown client"})
                      </div>
                      <div className="flex items-center gap-1.5">
                        <code className="text-sm font-mono break-all">{selectedConversation.idempotency_key}</code>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0"
                          onClick={() => { navigator.clipboard.writeText(selectedConversation.idempotency_key!); toast("Copied to clipboard", "success"); }}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Owner */}
                <div className="flex items-start gap-2">
                  <User className="h-4 w-4 text-muted-foreground mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-muted-foreground">Owner</div>
                    <div className="text-sm break-all">{selectedConversation.owner_id}</div>
                  </div>
                </div>

                {/* Agent */}
                <div className="flex items-start gap-2">
                  <Bot className="h-4 w-4 text-muted-foreground mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-muted-foreground">Agent</div>
                    <div className="text-sm">{getAgentName(selectedConversation.agent_id)}</div>
                    {selectedConversation.agent_id && (
                      <code className="text-xs text-muted-foreground font-mono break-all">{selectedConversation.agent_id}</code>
                    )}
                  </div>
                </div>

                {/* Status */}
                <div className="flex items-center gap-2">
                  <Archive className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Status</span>
                  {selectedConversation.deleted_at ? (
                    <Badge variant="outline" className="gap-1 text-orange-600 border-orange-300">Trash</Badge>
                  ) : selectedConversation.is_archived ? (
                    <Badge variant="outline" className="gap-1 text-muted-foreground">Archived</Badge>
                  ) : (
                    <Badge variant="outline" className="gap-1 text-green-600 border-green-300">Active</Badge>
                  )}
                </div>

                {/* Checkpoints */}
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Checkpoints</span>
                  <span className="text-sm">{selectedConversation.checkpoint_count}</span>
                </div>

                {/* Messages (WebUI only) */}
                {(selectedConversation.message_count ?? 0) > 0 && (
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Messages</span>
                    <span className="text-sm">{selectedConversation.message_count}</span>
                  </div>
                )}

                {/* Files */}
                {(selectedConversation.file_count ?? 0) > 0 && (
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Files</span>
                    <span className="text-sm">{selectedConversation.file_count}</span>
                  </div>
                )}

                {/* Dates */}
                <div className="flex items-start gap-2">
                  <Clock className="h-4 w-4 text-muted-foreground mt-0.5" />
                  <div>
                    <div className="text-sm">
                      <span className="text-muted-foreground">Created:</span>{" "}
                      {formatDate(selectedConversation.created_at)}
                    </div>
                    <div className="text-sm">
                      <span className="text-muted-foreground">Updated:</span>{" "}
                      {formatDate(selectedConversation.updated_at)}
                    </div>
                    {selectedConversation.deleted_at && (
                      <div className="text-sm">
                        <span className="text-muted-foreground">Deleted:</span>{" "}
                        {formatDate(selectedConversation.deleted_at)}
                      </div>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex justify-end pt-2 border-t">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => { handleClear(selectedConversation.id); setSelectedConversation(null); }}
                    disabled={clearingId === selectedConversation.id}
                  >
                    {clearingId === selectedConversation.id ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <Trash2 className="h-4 w-4 mr-2" />
                    )}
                    Delete All
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      </Card>
    </>
  );
}
