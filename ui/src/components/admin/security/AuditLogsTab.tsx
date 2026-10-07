"use client";

import { getErrorMessage } from "@/lib/error-utils";

import { ConversationDetailDialog } from "@/components/admin/security/ConversationDetailDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card,CardContent,CardDescription,CardHeader,CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { AuditConversation } from "@/types/mongodb";
import {
Check,
ChevronLeft,
ChevronRight,
ChevronsUpDown,
Copy,
Download,
FileText,
Loader2,
RotateCcw,
Search,
X
} from "lucide-react";
import React,{ useCallback,useEffect,useRef,useState } from "react";

interface AuditLogsTabProps {
  onUserClick?: (email: string) => void;
}

interface PaginatedResult {
  items: AuditConversation[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "deleted", label: "Deleted" },
];

export function AuditLogsTab({ onUserClick }: AuditLogsTabProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [ownerEmail, setOwnerEmail] = useState("");
  const [searchTitle, setSearchTitle] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [status, setStatus] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);

  const [result, setResult] = useState<PaginatedResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [searched, setSearched] = useState(false);

  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [auditBackend, setAuditBackend] = useState<string | null>(null);
  const [auditReadsAvailable, setAuditReadsAvailable] = useState<boolean>(true);
  const [auditStorageLabel, setAuditStorageLabel] = useState<string | null>(null);
  const [auditReadsWarning, setAuditReadsWarning] = useState<string | null>(null);

  const [ownerQuery, setOwnerQuery] = useState("");
  const [ownerSuggestions, setOwnerSuggestions] = useState<string[]>([]);
  const [ownerDropdownOpen, setOwnerDropdownOpen] = useState(false);
  const [ownerLoading, setOwnerLoading] = useState(false);
  const ownerRef = useRef<HTMLDivElement>(null);
  const ownerDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (ownerDebounceRef.current) clearTimeout(ownerDebounceRef.current);
    ownerDebounceRef.current = setTimeout(async () => {
      setOwnerLoading(true);
      try {
        const params = new URLSearchParams();
        if (ownerQuery.trim()) params.set("q", ownerQuery.trim());
        const res = await fetch(`/api/admin/audit-logs/owners?${params.toString()}`);
        const json = await res.json();
        if (json.success) setOwnerSuggestions(json.data.owners || []);
      } catch {
        /* swallow */
      } finally {
        setOwnerLoading(false);
      }
    }, 250);
    return () => {
      if (ownerDebounceRef.current) clearTimeout(ownerDebounceRef.current);
    };
  }, [ownerQuery]);

  useEffect(() => {
    fetch("/api/audit/config")
      .then((r) => r.json())
      .then((d: { backend?: string; readsAvailable?: boolean; readsWarning?: string; storageLabel?: string }) => {
        setAuditBackend(d.backend ?? null);
        setAuditReadsAvailable(d.readsAvailable ?? true);
        setAuditStorageLabel(d.storageLabel ?? null);
        setAuditReadsWarning(d.readsWarning ?? null);
      })
      .catch(() => {});
  }, []);

  // Auto-load audit logs on mount so the user sees results immediately
  useEffect(() => {
    fetchAuditLogs(1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ownerDropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (ownerRef.current && !ownerRef.current.contains(e.target as Node)) {
        setOwnerDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [ownerDropdownOpen]);

  const selectOwner = (owner: string) => {
    setOwnerEmail(owner);
    setOwnerQuery(owner);
    setOwnerDropdownOpen(false);
  };

  const clearOwner = () => {
    setOwnerEmail("");
    setOwnerQuery("");
    setOwnerSuggestions([]);
  };

  const fetchAuditLogs = useCallback(async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("page", String(p));
      params.set("page_size", "20");
      if (ownerEmail.trim()) params.set("owner_email", ownerEmail.trim());
      if (searchTitle.trim()) params.set("search", searchTitle.trim());
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      if (status) params.set("status", status);
      if (includeDeleted) params.set("include_deleted", "true");

      const res = await fetch(`/api/admin/audit-logs?${params.toString()}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to load audit logs");
      setResult(json.data);
      setSearched(true);
    } catch (err) {
      setError(getErrorMessage(err, ""));
    } finally {
      setLoading(false);
    }
  }, [ownerEmail, searchTitle, dateFrom, dateTo, status, includeDeleted]);

  const handleSearch = (e?: React.FormEvent) => {
    e?.preventDefault();
    setPage(1);
    fetchAuditLogs(1);
  };

  const handleReset = () => {
    setOwnerEmail("");
    setOwnerQuery("");
    setSearchTitle("");
    setDateFrom("");
    setDateTo("");
    setStatus("");
    setIncludeDeleted(false);
    setResult(null);
    setSearched(false);
    setError(null);
    setPage(1);
  };

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    fetchAuditLogs(newPage);
  };

  const openDetail = (id: string) => {
    setSelectedConversationId(id);
    setDetailOpen(true);
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (ownerEmail.trim()) params.set("owner_email", ownerEmail.trim());
      if (searchTitle.trim()) params.set("search", searchTitle.trim());
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      if (status) params.set("status", status);
      if (includeDeleted) params.set("include_deleted", "true");

      const res = await fetch(`/api/admin/audit-logs/export?${params.toString()}`);
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error || `Export failed (${res.status})`);
      }

      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
      const filename = filenameMatch?.[1] || "audit-logs.csv";

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(getErrorMessage(err, ""));
    } finally {
      setExporting(false);
    }
  };

  const copyId = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const statusBadge = (s: string) => {
    switch (s) {
      case "active":
        return <Badge className="bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30 text-[10px] px-1.5 py-0">Active</Badge>;
      case "archived":
        return <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30 text-[10px] px-1.5 py-0">Archived</Badge>;
      case "deleted":
        return <Badge variant="destructive" className="text-[10px] px-1.5 py-0">Deleted</Badge>;
      default:
        return <Badge variant="outline" className="text-[10px] px-1.5 py-0">{s}</Badge>;
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Chat Audit
            {auditBackend && (
              <Badge
                variant={auditReadsAvailable ? "outline" : "destructive"}
                className="text-xs font-normal"
                title={auditReadsAvailable ? undefined : auditReadsWarning ?? "Audit reads unavailable — check server logs"}
              >
                {auditStorageLabel ?? `storage: ${auditBackend}`}{!auditReadsAvailable && " (degraded)"}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Browse all conversations and messages across all users for compliance and auditing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Filters */}
          <form onSubmit={handleSearch} className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              <div ref={ownerRef} className="relative">
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  Owner Email
                </label>
                <div className="relative">
                  <Input
                    placeholder="Search owners..."
                    value={ownerQuery}
                    onChange={(e) => {
                      setOwnerQuery(e.target.value);
                      setOwnerEmail(e.target.value);
                      setOwnerDropdownOpen(true);
                    }}
                    onFocus={() => setOwnerDropdownOpen(true)}
                    className="h-8 text-sm pr-14"
                    autoComplete="off"
                  />
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                    {ownerQuery && (
                      <button
                        type="button"
                        onClick={clearOwner}
                        className="p-0.5 rounded hover:bg-muted"
                      >
                        <X className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setOwnerDropdownOpen(!ownerDropdownOpen)}
                      className="p-0.5 rounded hover:bg-muted"
                    >
                      <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
                    </button>
                  </div>
                </div>
                {ownerDropdownOpen && (
                  <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-lg max-h-48 overflow-y-auto">
                    {ownerLoading ? (
                      <div className="flex items-center justify-center py-3">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    ) : ownerSuggestions.length === 0 ? (
                      <div className="py-2 px-3 text-xs text-muted-foreground">
                        No owners found
                      </div>
                    ) : (
                      ownerSuggestions.map((owner) => (
                        <button
                          key={owner}
                          type="button"
                          onClick={() => selectOwner(owner)}
                          className={`w-full text-left px-3 py-1.5 text-sm hover:bg-muted/60 truncate ${
                            ownerEmail === owner ? "bg-muted font-medium" : ""
                          }`}
                        >
                          {owner}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  Title Search
                </label>
                <Input
                  placeholder="Search conversation titles..."
                  value={searchTitle}
                  onChange={(e) => setSearchTitle(e.target.value)}
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  From Date
                </label>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  To Date
                </label>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="h-8 text-sm"
                />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div>
                <Select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="h-8 text-sm rounded-md border border-input bg-background px-3 py-1 text-foreground"
                >
                  {STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </Select>
              </div>
              <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeDeleted}
                  onChange={(e) => setIncludeDeleted(e.target.checked)}
                  className="rounded border-input"
                />
                Include deleted
              </label>
              <div className="flex-1" />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleReset}
                className="gap-1.5"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset
              </Button>
              <Button type="submit" size="sm" disabled={loading} className="gap-1.5">
                {loading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Search className="h-3.5 w-3.5" />
                )}
                Search
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleExport}
                disabled={exporting}
                className="gap-1.5"
                title="Download matching conversations as CSV"
              >
                {exporting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                Download CSV
              </Button>
            </div>
          </form>

          {/* Error */}
          {error && (
            <div className="text-sm text-destructive text-center py-4">{error}</div>
          )}

          {/* Empty state before search */}
          {!searched && !loading && !error && (
            <div className="text-center py-12 text-muted-foreground">
              <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-sm">Use the filters above and click Search to browse conversations.</p>
            </div>
          )}

          {/* Results table */}
          {result && (
            <>
              <div className="text-xs text-muted-foreground">
                {result.total} conversation{result.total !== 1 ? "s" : ""} found
              </div>
              {result.items.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  No conversations match your filters.
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="grid grid-cols-[2fr_2fr_minmax(0,1fr)_auto_1fr_1fr_auto] gap-2 pb-2 border-b text-xs font-medium text-muted-foreground">
                    <div>Owner</div>
                    <div>Title</div>
                    <div>ID</div>
                    <div className="text-center">Msgs</div>
                    <div>Created</div>
                    <div>Updated</div>
                    <div className="text-center">Status</div>
                  </div>
                  {result.items.map((conv) => (
                    <div
                      key={conv._id}
                      onClick={() => openDetail(conv._id)}
                      className="grid grid-cols-[2fr_2fr_minmax(0,1fr)_auto_1fr_1fr_auto] gap-2 py-2 text-sm hover:bg-muted/50 rounded px-1 cursor-pointer items-center"
                    >
                      <div className={`truncate ${onUserClick ? 'text-primary hover:underline cursor-pointer' : ''}`} onClick={(e) => { if (onUserClick) { e.stopPropagation(); onUserClick(conv.owner_id); } }}>{conv.owner_id}</div>
                      <div className="truncate font-medium">{conv.title}</div>
                      <div className="flex items-center gap-1 min-w-0">
                        <a
                          href={`/chat/${conv._id}?from=audit-logs`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-xs text-primary hover:underline truncate font-mono"
                          title={conv._id}
                        >
                          {conv._id.slice(0, 8)}...
                        </a>
                        <button
                          onClick={(e) => copyId(e, conv._id)}
                          className="shrink-0 p-0.5 rounded hover:bg-muted"
                          title="Copy conversation ID"
                        >
                          {copiedId === conv._id ? (
                            <Check className="h-3 w-3 text-green-500" />
                          ) : (
                            <Copy className="h-3 w-3 text-muted-foreground" />
                          )}
                        </button>
                      </div>
                      <div className="text-center text-muted-foreground">
                        {conv.message_count}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(conv.created_at).toLocaleDateString()}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(conv.updated_at).toLocaleDateString()}
                      </div>
                      <div className="text-center">
                        {statusBadge(conv.status)}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Pagination */}
              {result.total > result.page_size && (
                <div className="flex items-center justify-between pt-2 text-sm">
                  <span className="text-muted-foreground">
                    Page {result.page} of {Math.ceil(result.total / result.page_size)}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePageChange(page - 1)}
                      disabled={page <= 1 || loading}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePageChange(page + 1)}
                      disabled={!result.has_more || loading}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <ConversationDetailDialog
        conversationId={selectedConversationId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onDeleted={() => fetchAuditLogs(1)}
      />
    </>
  );
}
