"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Brain, Check, Copy, Download, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

export interface MemoryRecord {
  memory_id: string;
  title: string;
  value: string;
  source: "agent" | "manual" | string;
  created_by_agent_id?: string | null;
  created_at: string;
  updated_at: string;
  extra?: Record<string, string>;
}

export interface MemoryFile {
  path: string;
  text: string;
  etag?: string;
  scope: "global" | "agent" | "project";
  metadata?: Record<string, string>;
  records: MemoryRecord[];
  preamble?: string;
  char_count: number;
  max_chars: number;
  over_budget: boolean;
  updated_at?: string | null;
}

interface MemoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  focusIds: string[];
  agentId: string;
  projectId?: string | null;
}

const EMPTY_TEXT: Record<MemoryFile["scope"], string> = {
  global: "<!-- caipe-memory:file v=1 scope=global -->\n_No memories saved here yet._\n",
  agent: "<!-- caipe-memory:file v=1 scope=agent -->\n_No memories saved here yet._\n",
  project: "<!-- caipe-memory:file v=1 scope=project -->\n_No memories saved here yet._\n",
};

function scopeForPath(path: string): MemoryFile["scope"] {
  if (path === "/memories/global/AGENTS.md") return "global";
  return path.startsWith("/memories/agents/") ? "agent" : "project";
}

function labelForFile(file: MemoryFile, agentId: string): string {
  if (file.scope === "global") return "Global";
  const key = file.path.split("/")[3] || "unknown";
  if (file.scope === "agent") return `Agent: ${key === agentId ? "this agent" : key}`;
  return `Project: ${file.metadata?.project_name || key}`;
}

function virtualFile(path: string, maxChars: number): MemoryFile {
  const scope = scopeForPath(path);
  return {
    path,
    text: EMPTY_TEXT[scope],
    scope,
    records: [],
    char_count: EMPTY_TEXT[scope].length,
    max_chars: maxChars,
    over_budget: false,
  };
}

function charCount(value: string): number {
  return Array.from(value).length;
}

export function memoryEntryCount(file: Pick<MemoryFile, "records" | "preamble">): number {
  return file.records.length + (file.preamble?.trim() ? 1 : 0);
}

interface DuplicateTitleConflict {
  existingMemoryId: string;
  message: string;
}

function payloadMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const envelope = payload as { detail?: unknown; error?: unknown };
  const detail = envelope.detail;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string") {
    return detail.message;
  }
  return typeof envelope.error === "string" ? envelope.error : fallback;
}

function duplicateTitleConflict(payload: unknown): DuplicateTitleConflict | null {
  if (!payload || typeof payload !== "object" || !("detail" in payload)) return null;
  const detail = payload.detail;
  if (!detail || typeof detail !== "object") return null;
  if (!("code" in detail) || detail.code !== "duplicate_memory_title") return null;
  if (!("existing_memory_id" in detail) || typeof detail.existing_memory_id !== "string") {
    return null;
  }
  return {
    existingMemoryId: detail.existing_memory_id,
    message: "message" in detail && typeof detail.message === "string"
      ? detail.message
      : "A memory with this title already exists.",
  };
}

function sourceLabel(source: string): string {
  if (source === "agent") return "Added by agent";
  if (source === "manual") return "Added by you";
  return source;
}

export function MemoryDialog({
  open,
  onOpenChange,
  focusIds,
  agentId,
  projectId,
}: MemoryDialogProps) {
  const [files, setFiles] = useState<MemoryFile[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [mode, setMode] = useState<"list" | "source">("list");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [duplicateConflict, setDuplicateConflict] = useState<DuplicateTitleConflict | null>(null);
  const [sourceCopied, setSourceCopied] = useState(false);

  const activePaths = useMemo(() => {
    const paths = [
      "/memories/global/AGENTS.md",
      `/memories/agents/${agentId}/AGENTS.md`,
    ];
    if (projectId) paths.push(`/memories/projects/${projectId}/AGENTS.md`);
    return paths;
  }, [agentId, projectId]);

  const selected = files.find((file) => file.path === selectedPath);
  const maxChars = selected?.max_chars ?? 8000;
  const estimatedAddSize = (selected?.char_count ?? 0) + charCount(newTitle) + charCount(newBody) + 120;
  const focusSet = useMemo(() => new Set(focusIds), [focusIds]);
  const editingRecord = selected?.records.find((record) => record.memory_id === editingId);

  const applyLoadedFiles = useCallback((loaded: MemoryFile[], configuredMax: number) => {
    const byPath = new Map(loaded.map((file) => [file.path, file]));
    for (const path of activePaths) {
      if (!byPath.has(path)) byPath.set(path, virtualFile(path, configuredMax));
    }
    const next = [...byPath.values()];
    setFiles(next);
    setSelectedPath((current) => {
      const focused = next.find((file) => file.records.some((record) => focusSet.has(record.memory_id)));
      if (focused) return focused.path;
      if (current && byPath.has(current)) return current;
      return activePaths[0];
    });
  }, [activePaths, focusSet]);

  const load = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/user/memories", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.detail || payload.error || "Failed to load memory");
      applyLoadedFiles(payload.data?.files ?? [], payload.data?.max_file_chars ?? 8000);
      setRemoteChanged(false);
    } catch (caught) {
      setError((caught as Error).message || "Failed to load memory");
    } finally {
      setLoading(false);
    }
  }, [applyLoadedFiles, open]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!selected) return;
    setConflict(false);
    setEditingId(null);
    setDuplicateConflict(null);
    setSourceCopied(false);
  }, [selected]);

  useEffect(() => {
    if (!open || !selected || saving) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch("/api/user/memories", { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json();
        const remote = (payload.data?.files as MemoryFile[] | undefined)?.find((file) => file.path === selected.path);
        if (remote && remote.etag !== selected.etag) setRemoteChanged(true);
      } catch {
        // Polling is best-effort and never interrupts editing.
      }
    }, 10000);
    return () => window.clearInterval(timer);
  }, [open, saving, selected]);

  const replaceFile = (file: MemoryFile) => {
    setFiles((current) => current.map((item) => item.path === file.path ? file : item));
    setConflict(false);
    setRemoteChanged(false);
  };

  const addMemory = async () => {
    if (!selected || !newTitle.trim() || !newBody.trim() || estimatedAddSize > maxChars) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/user/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selected.path, title: newTitle, body: newBody, etag: selected.etag }),
      });
      const payload = await response.json();
      if (response.status === 409) {
        const duplicate = duplicateTitleConflict(payload);
        if (duplicate) setDuplicateConflict(duplicate);
        else setConflict(true);
        return;
      }
      if (!response.ok || !payload.success) throw new Error(payloadMessage(payload, "Failed to add memory"));
      replaceFile(payload.data.file as MemoryFile);
      setNewTitle("");
      setNewBody("");
      setDuplicateConflict(null);
    } catch (caught) {
      setError((caught as Error).message || "Failed to add memory");
    } finally {
      setSaving(false);
    }
  };

  const startEditing = (record: MemoryRecord) => {
    setEditingId(record.memory_id);
    setEditTitle(record.title);
    setEditBody(record.value);
    setDuplicateConflict(null);
  };

  const updateMemory = async () => {
    if (!selected || !editingRecord || !editTitle.trim() || !editBody.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/user/memories", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: selected.path,
          memory_id: editingRecord.memory_id,
          title: editTitle,
          body: editBody,
          etag: selected.etag,
        }),
      });
      const payload = await response.json();
      if (response.status === 409) {
        const duplicate = duplicateTitleConflict(payload);
        if (duplicate) setError(`${duplicate.message} Choose a unique title.`);
        else setConflict(true);
        return;
      }
      if (!response.ok || !payload.success) throw new Error(payloadMessage(payload, "Failed to update memory"));
      replaceFile(payload.data.file as MemoryFile);
      setEditingId(null);
      setEditTitle("");
      setEditBody("");
    } catch (caught) {
      setError((caught as Error).message || "Failed to update memory");
    } finally {
      setSaving(false);
    }
  };

  const deleteRecord = async (record: MemoryRecord) => {
    if (!selected || !window.confirm("Delete this memory?")) return;
    setSaving(true);
    try {
      const params = new URLSearchParams({
        id: record.memory_id,
        path: selected.path,
        mounted: String(activePaths.includes(selected.path)),
      });
      if (selected.etag) params.set("etag", selected.etag);
      const response = await fetch(`/api/user/memories?${params}`, { method: "DELETE" });
      const payload = await response.json();
      if (response.status === 409) { setConflict(true); return; }
      if (!response.ok || !payload.success) throw new Error(payload.detail || payload.error || "Failed to delete memory");
      if (payload.data?.file) replaceFile(payload.data.file as MemoryFile);
      else await load();
    } catch (caught) {
      setError((caught as Error).message || "Failed to delete memory");
    } finally {
      setSaving(false);
    }
  };

  const copySource = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.text);
      setSourceCopied(true);
      window.setTimeout(() => setSourceCopied(false), 2000);
    } catch {
      setError("Could not copy AGENTS.md source");
    }
  };

  const downloadSource = () => {
    if (!selected) return;
    const parts = selected.path.split("/").filter(Boolean);
    const scopeKey = parts.slice(1, -1).join("-") || selected.scope;
    const anchor = document.createElement("a");
    anchor.href = `data:text/markdown;charset=utf-8,${encodeURIComponent(selected.text)}`;
    anchor.download = `${scopeKey}-AGENTS.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const clearFile = async () => {
    if (!selected) return;
    const mounted = activePaths.includes(selected.path);
    if (!window.confirm(mounted ? "Clear every memory in this file?" : "Delete this unmounted memory file?")) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/user/memories", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: selected.path,
          text: "",
          etag: selected.etag,
          mounted,
        }),
      });
      const payload = await response.json();
      if (response.status === 409) { setConflict(true); return; }
      if (!response.ok || !payload.success) throw new Error(payload.detail || payload.error || "Failed to clear memory");
      if (payload.data?.file) replaceFile(payload.data.file as MemoryFile);
      else await load();
    } catch (caught) {
      setError((caught as Error).message || "Failed to clear memory");
    } finally {
      setSaving(false);
    }
  };

  const active = files.filter((file) => activePaths.includes(file.path));
  const other = files
    .filter((file) => !activePaths.includes(file.path))
    .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Brain className="h-5 w-5 text-sky-300" />Manage Memory</DialogTitle>
          <DialogDescription>Private Markdown memory mounted into this user&apos;s agent chats.</DialogDescription>
        </DialogHeader>

        <div className="grid min-h-[520px] grid-cols-[220px_1fr] overflow-hidden rounded-md border">
          <aside className="border-r bg-muted/20 p-2">
            <p className="px-2 py-1 text-[11px] font-semibold uppercase text-muted-foreground">Active in this chat</p>
            {[active, other].map((group, groupIndex) => (
              <div key={groupIndex} className="space-y-1">
                {groupIndex === 1 && group.length > 0 && <p className="mt-4 px-2 py-1 text-[11px] font-semibold uppercase text-muted-foreground">Other</p>}
                {group.map((file) => {
                  const focused = file.records.some((record) => focusSet.has(record.memory_id));
                  return (
                    <button
                      type="button"
                      key={file.path}
                      onClick={() => setSelectedPath(file.path)}
                      className={cn(
                        "flex w-full items-center justify-between rounded px-2 py-2 text-left text-xs hover:bg-muted",
                        selectedPath === file.path && "bg-muted font-medium",
                        focused && "ring-1 ring-sky-400",
                      )}
                    >
                      <span className="truncate">{labelForFile(file, agentId)}</span>
                      <span className="ml-2 text-muted-foreground">{memoryEntryCount(file)}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </aside>

          <section className="min-w-0 p-4">
            {error && (
              <div className="mb-3 flex items-center justify-between gap-3 rounded border border-red-500/25 bg-red-500/10 p-2 text-xs text-red-300">
                <span>{error}</span>
                <Button size="sm" variant="ghost" onClick={() => void load()}>Retry</Button>
              </div>
            )}
            {conflict && (
              <div className="mb-3 flex items-center justify-between rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
                <span>The agent changed this file while you were editing.</span>
                <Button size="sm" variant="ghost" onClick={() => void load()}>Reload</Button>
              </div>
            )}
            {remoteChanged && <button className="mb-3 rounded-full border px-2 py-1 text-xs" onClick={() => void load()}>Memory changed — Refresh</button>}
            {loading || !selected ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading</div>
            ) : (
              <>
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{labelForFile(selected, agentId)}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">{selected.path}</p>
                    <p className="text-xs text-muted-foreground">
                      {selected.char_count.toLocaleString()} / {maxChars.toLocaleString()} chars
                      {selected.updated_at ? ` · Updated ${new Date(selected.updated_at).toLocaleString()}` : ""}
                    </p>
                  </div>
                  <div className="flex rounded border p-0.5">
                    <Button size="sm" variant={mode === "list" ? "secondary" : "ghost"} onClick={() => setMode("list")}>Memories</Button>
                    <Button size="sm" variant={mode === "source" ? "secondary" : "ghost"} onClick={() => setMode("source")}>Source</Button>
                  </div>
                </div>

                {selected.over_budget && <div className="mb-3 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs">This file is over 8 KB. Prune it before adding memory.</div>}
                {mode === "source" ? (
                  <div className="space-y-2">
                    <div className="rounded border border-sky-500/25 bg-sky-500/5 p-2 text-xs text-muted-foreground">
                      Read-only internal source. Use Memories to add, edit, or delete records.
                    </div>
                    <Textarea aria-label="AGENTS.md source" value={selected.text} readOnly className="min-h-[330px] font-mono text-xs" />
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{selected.char_count.toLocaleString()} characters</span>
                      <div className="flex gap-2">
                        <Button variant="ghost" onClick={() => void copySource()}>{sourceCopied ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />}{sourceCopied ? "Copied" : "Copy"}</Button>
                        <Button variant="ghost" onClick={downloadSource}><Download className="mr-1 h-4 w-4" />Download</Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <ScrollArea className="h-[340px] pr-3">
                    <div className="space-y-2">
                      {selected.preamble && <div className="rounded border border-dashed p-3 text-xs text-muted-foreground">Freeform content: {selected.preamble}</div>}
                      {selected.records.length === 0 && !selected.preamble && <div className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">No memories saved here yet.</div>}
                      {selected.records.map((record) => (
                        <div key={record.memory_id} className={cn("rounded border p-3", focusSet.has(record.memory_id) && "border-sky-400 bg-sky-500/5")}>
                          <div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium">{record.title}</p><Badge variant="secondary" className="mt-1">{sourceLabel(record.source)}</Badge></div><div className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => startEditing(record)}>Edit</Button><Button size="icon" variant="ghost" onClick={() => void deleteRecord(record)}><Trash2 className="h-4 w-4" /></Button></div></div>
                          <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{record.value}</p>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}

                {mode === "list" && (
                  <>
                    {editingRecord ? (
                      <div className="mt-4 space-y-2 border-t pt-3">
                        <p className="text-xs font-medium">Edit memory</p>
                        <Input aria-label="Memory title" placeholder="Memory title" value={editTitle} onChange={(event) => setEditTitle(event.target.value)} />
                        <Textarea aria-label="Memory body" placeholder="What should the agent remember?" value={editBody} onChange={(event) => setEditBody(event.target.value)} className="min-h-20" />
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
                          <Button onClick={() => void updateMemory()} disabled={saving || !editTitle.trim() || !editBody.trim()}><Save className="mr-1 h-4 w-4" />Save</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-4 space-y-2 border-t pt-3">
                        <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                          <Input placeholder="Memory title" value={newTitle} onChange={(event) => { setNewTitle(event.target.value); setDuplicateConflict(null); }} />
                          <Input placeholder="What should the agent remember?" value={newBody} onChange={(event) => setNewBody(event.target.value)} />
                          <Button onClick={() => void addMemory()} disabled={saving || !newTitle.trim() || !newBody.trim() || estimatedAddSize > maxChars}><Plus className="mr-1 h-4 w-4" />Add</Button>
                        </div>
                        {duplicateConflict && (
                          <div className="flex items-center justify-between gap-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
                            <span>{duplicateConflict.message} Update it or choose a different title.</span>
                            <Button size="sm" variant="ghost" onClick={() => {
                              const existing = selected.records.find((record) => record.memory_id === duplicateConflict.existingMemoryId);
                              if (existing) startEditing(existing);
                            }}>Edit existing</Button>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="mt-2 flex justify-between text-xs text-muted-foreground"><span>{estimatedAddSize > maxChars ? "Adding this would exceed 8 KB." : ""}</span><Button size="sm" variant="ghost" onClick={() => void clearFile()} disabled={saving}><Trash2 className="mr-1 h-3.5 w-3.5" />{activePaths.includes(selected.path) ? "Clear" : "Delete file"}</Button></div>
                  </>
                )}
              </>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
