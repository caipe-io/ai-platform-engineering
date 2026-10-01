"use client";

import { CheckCircle2, Loader2, RefreshCw, RotateCcw, Save, XCircle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AgentPicker, type AgentPickerOption } from "@/components/ui/agent-picker";
import { ConnectorIdentityPicker } from "@/components/admin/rebac/ConnectorIdentityPicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CAIPESpinner } from "@/components/ui/caipe-spinner";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { findSettingsRouteById } from "@/components/settings/settings-routes";
import { loadAllDynamicAgents } from "@/lib/dynamic-agent-list";
import type { DynamicAgentOption } from "./connector-admin-adapter";

const ACCOUNT_ACCESS_SETTINGS_HREF = findSettingsRouteById("access")?.href ?? "/settings/account-and-access";

type DmAccessMode = "disabled" | "allowlist" | "all_users";

interface BotOption {
  id: string;
  name: string;
  available: boolean;
}

interface DirectUserRow {
  keycloak_user_id: string;
  email: string;
  display_name: string;
  linked: boolean;
  enabled: boolean;
  configured: boolean;
  inherited: boolean;
  state: "disabled" | "inherited" | "denied" | "allowlisted" | "overridden" | "not_allowed";
  agent_id: string;
}

interface DirectUsersResponse {
  users: DirectUserRow[];
  bot_id: string;
  dm_access_mode: DmAccessMode;
  default_agent_id: string | null;
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

function apiData<T>(payload: { data?: T } & T): T {
  return (payload.data ?? payload) as T;
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return `${fallback}: ${response.status}`;
  try {
    const payload = JSON.parse(text) as { error?: unknown; message?: unknown };
    const detail = typeof payload.error === "string" ? payload.error
      : typeof payload.message === "string" ? payload.message : "";
    return detail || `${fallback}: ${response.status}`;
  } catch {
    return text;
  }
}

export function WebexDirectUsersPanel({ disabled = false }: { disabled?: boolean }) {
  const { toast } = useToast();
  const [bots, setBots] = useState<BotOption[]>([]);
  const [selectedBotId, setSelectedBotId] = useState("");
  const [agents, setAgents] = useState<DynamicAgentOption[]>([]);
  const [data, setData] = useState<DirectUsersResponse | null>(null);
  const [rows, setRows] = useState<DirectUserRow[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Debounce the search box before it drives a server request — avoids
  // firing a fetch on every keystroke.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search]);

  // Every fetch is tagged with an incrementing id so a response can detect
  // it has been superseded (bot switch, search change, or page change) and
  // skip applying stale data instead of overwriting a newer result.
  const requestIdRef = useRef(0);
  // Tracks the (bot, search) pair the current `page` value was computed
  // for, so a bot/search change can force page back to 1 and skip fetching
  // until that reset has committed — otherwise this effect and the
  // page-reset would each fire their own request against the same render's
  // stale `page`.
  const pageResetKeyRef = useRef("");

  useEffect(() => {
    let active = true;
    void Promise.all([
      fetch("/api/admin/webex/bots", { cache: "no-store" }),
      loadAllDynamicAgents<DynamicAgentOption>({ enabledOnly: true }),
    ]).then(async ([botsResponse, nextAgents]) => {
      if (!botsResponse.ok) throw new Error(await responseError(botsResponse, "Failed to load Webex bots"));
      const botData = apiData<{ bots: BotOption[] }>(await botsResponse.json());
      if (!active) return;
      const nextBots = botData.bots ?? [];
      setBots(nextBots);
      setSelectedBotId((current) =>
        nextBots.some((bot) => bot.id === current && bot.available)
          ? current
          : nextBots.find((bot) => bot.available)?.id ?? "",
      );
      setAgents(nextAgents);
    }).catch((reason) => {
      if (active) {
        setError(reason instanceof Error ? reason.message : "Failed to load 1:1 settings");
        setLoading(false);
      }
    });
    return () => { active = false; };
  }, []);

  const loadUsers = useCallback(async (botId: string, pageArg: number, searchTerm: string) => {
    if (!botId) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        bot_id: botId,
        page: String(pageArg),
        page_size: String(PAGE_SIZE),
      });
      if (searchTerm) params.set("q", searchTerm);
      const response = await fetch(`/api/admin/webex/direct-users?${params.toString()}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await responseError(response, "Failed to load deployment users"));
      const next = apiData<DirectUsersResponse>(await response.json());
      if (requestIdRef.current !== requestId) return;
      setData(next);
      setRows(next.users ?? []);
    } catch (reason) {
      if (requestIdRef.current !== requestId) return;
      setError(reason instanceof Error ? reason.message : "Failed to load deployment users");
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, []);

  // Reset to page 1 whenever the search term or selected bot changes, and
  // only fetch once that reset has committed — otherwise this effect would
  // fire a fetch for the stale page in the same pass as the page-reset.
  useEffect(() => {
    if (!selectedBotId) return;
    const resetKey = `${selectedBotId} ${debouncedSearch}`;
    if (resetKey !== pageResetKeyRef.current) {
      pageResetKeyRef.current = resetKey;
      if (page !== 1) {
        setPage(1);
        return;
      }
    }
    void loadUsers(selectedBotId, page, debouncedSearch);
  }, [loadUsers, selectedBotId, page, debouncedSearch]);

  const agentOptions = useMemo(
    () => agents.map<AgentPickerOption>((agent) => ({
      value: agent._id,
      label: agent.name || agent._id,
    })),
    [agents],
  );

  const botOptions = useMemo(
    () => bots.filter((bot) => bot.available).map((bot) => ({ id: bot.id, label: bot.name })),
    [bots],
  );

  const updateRow = (userId: string, patch: Partial<DirectUserRow>) => {
    setRows((current) => current.map((row) => row.keycloak_user_id === userId ? { ...row, ...patch } : row));
  };

  const saveRow = async (row: DirectUserRow) => {
    if (!data) return;
    if (!selectedBotId) {
      toast("Select a Webex bot first.", "error");
      return;
    }
    if (row.enabled && !row.agent_id) {
      toast("Select an agent before enabling this user.", "error");
      return;
    }
    setSavingUserId(row.keycloak_user_id);
    try {
      const shouldDelete = data.dm_access_mode === "allowlist" && !row.enabled;
      const response = await fetch("/api/admin/webex/direct-users", {
        method: shouldDelete ? "DELETE" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bot_id: selectedBotId,
          keycloak_user_id: row.keycloak_user_id,
          agent_id: row.agent_id,
          enabled: row.enabled,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Failed to save 1:1 access"));
      toast(shouldDelete ? `Removed 1:1 routing for ${row.email}.` : `Saved 1:1 routing for ${row.email}.`, "success");
      await loadUsers(selectedBotId, page, debouncedSearch);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Failed to save 1:1 access", "error");
    } finally {
      setSavingUserId(null);
    }
  };

  const resetRow = async (row: DirectUserRow) => {
    setSavingUserId(row.keycloak_user_id);
    try {
      const response = await fetch("/api/admin/webex/direct-users", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bot_id: selectedBotId,
          keycloak_user_id: row.keycloak_user_id,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Failed to reset 1:1 access"));
      toast(`Reset 1:1 access for ${row.email} to the bot policy.`, "success");
      await loadUsers(selectedBotId, page, debouncedSearch);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "Failed to reset 1:1 access", "error");
    } finally {
      setSavingUserId(null);
    }
  };

  return (
    <div className="space-y-3" role="region" aria-label="Webex 1:1 message access">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span>Webex bot</span>
          <ConnectorIdentityPicker
            options={botOptions}
            value={selectedBotId}
            onChange={(botId) => {
              setSelectedBotId(botId);
              setData(null);
              setRows([]);
            }}
            disabled={disabled || savingUserId !== null}
            ariaLabel="Webex bot"
            allowClear
            triggerClassName="h-8 min-w-[12rem]"
          />
        </label>
        <Button type="button" variant="outline" size="sm" onClick={() => void loadUsers(selectedBotId, page, debouncedSearch)} disabled={disabled || loading || !selectedBotId}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {error && <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error}</div>}
      {data?.dm_access_mode === "disabled" && (
        <div className="rounded-md border p-3 text-sm text-muted-foreground">
          Direct messages are disabled for this bot.
        </div>
      )}
      {data?.dm_access_mode === "all_users" && (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
          <p>
            All enabled deployment users can message this bot. Each user uses
            this bot&apos;s configured default unless an admin saves an explicit
            override.
          </p>
          <p className="mt-1 text-muted-foreground">
            {data.default_agent_id
              ? `Bot default agent: ${data.default_agent_id}`
              : "No bot fallback is configured."}
          </p>
        </div>
      )}

      <div className="rounded-md border bg-background/60">
        <div className="border-b p-3">
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search deployment users" aria-label="Search deployment users" />
        </div>
        {loading ? (
          <div className="flex min-h-40 items-center justify-center"><CAIPESpinner size="sm" /></div>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/90 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="w-24 px-3 py-2 text-left font-medium">Allowed</th>
                  <th className="px-3 py-2 text-left font-medium">User</th>
                  <th className="px-3 py-2 text-left font-medium">Webex identity</th>
                  <th className="px-3 py-2 text-left font-medium">Agent</th>
                  <th className="w-28 px-3 py-2 text-left font-medium">Source</th>
                  <th className="w-24 px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const saving = savingUserId === row.keycloak_user_id;
                  const modeDisabled = data?.dm_access_mode === "disabled";
                  return (
                    <tr key={row.keycloak_user_id} className="border-t align-middle">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={row.enabled}
                          onChange={(event) => updateRow(row.keycloak_user_id, { enabled: event.target.checked })}
                          disabled={disabled || modeDisabled || saving}
                          aria-label={`Allow direct messages for ${row.email}`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{row.display_name}</div>
                        <div className="text-xs text-muted-foreground">{row.email}</div>
                      </td>
                      <td className="px-3 py-2">
                        {row.linked ? (
                          <span className="inline-flex items-center gap-1.5 text-sm text-green-500">
                            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                            Linked
                          </span>
                        ) : (
                          <Link
                            href={ACCOUNT_ACCESS_SETTINGS_HREF}
                            className="inline-flex items-center gap-1.5 text-sm text-red-500 hover:underline"
                          >
                            <XCircle className="h-4 w-4" aria-hidden="true" />
                            Unlinked
                          </Link>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <AgentPicker
                          ariaLabel={`Agent for ${row.email}`}
                          triggerClassName="h-8 min-w-56 px-2 py-1 text-sm"
                          value={row.agent_id}
                          onChange={(agentId) => updateRow(row.keycloak_user_id, { agent_id: agentId })}
                          disabled={disabled || modeDisabled || saving || (!row.enabled && data?.dm_access_mode === "allowlist")}
                          placeholder={data?.dm_access_mode === "all_users" ? "Deployment default" : "Select an agent"}
                          searchPlaceholder="Search agents..."
                          options={agentOptions}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={row.state === "denied" || row.state === "disabled" ? "outline" : "secondary"}>
                          {row.state.replace("_", " ")}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex justify-end gap-1">
                          {data?.dm_access_mode === "all_users" && row.configured && (
                            <Button type="button" size="icon" variant="ghost" title="Reset to inherited policy" onClick={() => void resetRow(row)} disabled={disabled || modeDisabled || saving}>
                              <RotateCcw className="h-4 w-4" aria-hidden="true" />
                              <span className="sr-only">Reset 1:1 access for {row.email}</span>
                            </Button>
                          )}
                          <Button type="button" size="icon" variant="ghost" title="Save 1:1 access" onClick={() => void saveRow(row)} disabled={disabled || modeDisabled || saving}>
                            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
                            <span className="sr-only">Save 1:1 access for {row.email}</span>
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No deployment users found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > 0 && (
          <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
            <span>
              Showing {(data.page - 1) * data.page_size + 1}
              –{Math.min(data.page * data.page_size, data.total)} of {data.total}
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={disabled || loading || page <= 1}
              >
                Prev
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPage((current) => current + 1)}
                disabled={disabled || loading || !data.has_more || page * data.page_size >= data.total}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
