"use client";

import { TeamPicker, type TeamPickerOption } from "@/components/ui/team-picker";
import {
  withAdminSimulationParams,
  type AdminSimulationQueryTarget,
} from "@/lib/rbac/admin-simulation-query";
import { ChevronDown, Loader2 } from "lucide-react";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

export interface UserDetailModalProps {
  userId: string;
  onClose: () => void;
  onSaved: () => void;
  readOnly?: boolean;
  simulationTarget?: AdminSimulationQueryTarget | null;
  /** Pre-loaded team list from the parent page — skips the /api/admin/teams fetch. */
  teamOptions?: Array<{ teamId: string; label: string }>;
}

type ProfileUser = {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  enabled: boolean;
  createdAt?: number | null;
  attributes: Record<string, string[]>;
  slackLinkStatus: "linked" | "unlinked";
  teams: Array<{ team_id: string; tenant_id: string }>;
};

type IdentityInfo = {
  sessions: Array<{ id: string; start?: number; lastAccess?: number }>;
  federatedIdentities: Array<{
    identityProvider: string;
    userId: string;
    userName: string;
  }>;
  lastAccess: number | null;
};

type AccessVia = {
  /**
   * `team` — granted through team membership (attributed to team_slug/role).
   * `owned` — the user personally owns the resource, independent of any team.
   * `effective` — access is direct, global, collection-derived, or inherited
   * through an external identity group.
   */
  kind?: "team" | "owned" | "effective";
  team_slug: string;
  team_name: string;
  role: "member" | "admin";
};

type AccessItem = {
  id: string;
  name: string;
  capability: string;
  via: AccessVia[];
};

type AccessGroups = {
  agents: AccessItem[];
  tools: AccessItem[];
  knowledge_bases: AccessItem[];
  skills: AccessItem[];
  workflows: AccessItem[];
};

const ACCESS_GROUP_LABELS: Array<{ key: keyof AccessGroups; label: string }> = [
  { key: "agents", label: "Agents" },
  { key: "tools", label: "Tools" },
  { key: "knowledge_bases", label: "RAG" },
  { key: "skills", label: "Skills" },
  { key: "workflows", label: "Workflows" },
];

// A group with hundreds of grants would blow out the modal; collapse to a
// preview and let the admin expand the ones they care about.
const ACCESS_COLLAPSED_LIMIT = 8;
const TEAM_COLLAPSED_LIMIT = 8;

function AccessGroupList({ label, items }: { label: string; items: AccessItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, ACCESS_COLLAPSED_LIMIT);
  const hidden = items.length - visible.length;

  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
        {label} <span className="font-normal normal-case">({items.length})</span>
      </h4>
      <ul className="space-y-1.5">
        {visible.map((item) => (
          <li
            key={`${item.id}:${item.capability}`}
            className="flex flex-col gap-1 rounded-lg border border-border bg-muted/40 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <span className="text-sm font-medium text-foreground truncate">
                {item.name}
              </span>
              <span className="ml-2 inline-flex items-center rounded-full bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {item.capability}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5 shrink-0">
              {item.via.map((v) =>
                v.kind === "owned" ? (
                  <span
                    key="owned"
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground"
                    title="Owned directly by this user"
                  >
                    Owned by user
                  </span>
                ) : v.kind === "effective" ? (
                  <span
                    key="effective"
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground"
                    title="Granted directly, globally, through a collection, or through an external group"
                  >
                    Effective access
                  </span>
                ) : (
                  <span
                    key={v.team_slug}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground"
                    title={`Granted via team ${v.team_name} (${v.role})`}
                  >
                    {v.team_name}
                    <span className="text-muted-foreground/70">· {v.role}</span>
                  </span>
                ),
              )}
            </div>
          </li>
        ))}
      </ul>
      {items.length > ACCESS_COLLAPSED_LIMIT && (
        <button
          type="button"
          className="mt-2 text-xs font-medium text-primary hover:underline"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? "Show less" : `Show ${hidden} more`}
        </button>
      )}
    </div>
  );
}

function formatTs(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function UserDetailModal({
  userId,
  onClose,
  onSaved,
  readOnly = false,
  simulationTarget = null,
  teamOptions: teamOptionsProp,
}: UserDetailModalProps) {
  const { update: updateSession } = useSession();
  const [mounted, setMounted] = useState(false);
  // Profile section
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [user, setUser] = useState<ProfileUser | null>(null);
  // Team picker options — use prop if provided, otherwise fetch
  const [teamOptionsLoading, setTeamOptionsLoading] = useState(!readOnly && !teamOptionsProp);
  const [teamOptionsFetched, setTeamOptionsFetched] = useState<
    Array<{ teamId: string; label: string }>
  >([]);
  const teamOptions = teamOptionsProp ?? teamOptionsFetched;
  const [addTeamValue, setAddTeamValue] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Access section
  const [access, setAccess] = useState<AccessGroups | null>(null);
  const [accessLoading, setAccessLoading] = useState(true);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [teamsExpanded, setTeamsExpanded] = useState(false);
  // Identity section (lazy — sessions + federated identities from Keycloak)
  const [identity, setIdentity] = useState<IdentityInfo | null>(null);
  const [identityLoading, setIdentityLoading] = useState(true);
  const withPreviewScope = useCallback(
    (path: string) => withAdminSimulationParams(path, simulationTarget),
    [simulationTarget],
  );

  const refreshProfile = useCallback(async () => {
    setProfileError(null);
    const res = await fetch(
      withPreviewScope(`/api/admin/users/${encodeURIComponent(userId)}`),
    );
    const json = (await readJson(res)) as {
      success?: boolean;
      data?: { user?: ProfileUser };
      error?: string;
    } | null;
    if (!res.ok || !json?.success || !json.data?.user) {
      throw new Error(
        (json && typeof json === "object" && "error" in json && json.error
          ? String(json.error)
          : null) || `Failed to load user (${res.status})`
      );
    }
    setUser(json.data.user);
  }, [userId, withPreviewScope]);

  const loadTeams = useCallback(async () => {
    if (teamOptionsProp) return; // parent already supplied the list
    // /api/dynamic-agents/teams is a single MongoDB query (no OpenFGA fan-out)
    // and returns all teams for admins — sufficient for the picker.
    const teamsRes = await fetch("/api/dynamic-agents/teams");
    const teamsJson = (await readJson(teamsRes)) as {
      success?: boolean;
      data?: Array<{ name?: string; slug?: string }>;
    } | null;
    if (teamsRes.ok && teamsJson?.success && Array.isArray(teamsJson.data)) {
      setTeamOptionsFetched(
        teamsJson.data
          .map((t) => {
            const name = typeof t.name === "string" ? t.name.trim() : "";
            if (!name) return null;
            return { teamId: t.slug ?? name, label: name };
          })
          .filter((x): x is { teamId: string; label: string } => x != null)
      );
    } else {
      setTeamOptionsFetched([]);
    }
  }, [teamOptionsProp]);

  const loadIdentity = useCallback(async () => {
    setIdentityLoading(true);
    try {
      const res = await fetch(
        withPreviewScope(`/api/admin/users/${encodeURIComponent(userId)}/identity`),
      );
      const json = (await readJson(res)) as {
        success?: boolean;
        data?: IdentityInfo;
        error?: string;
      } | null;
      if (res.ok && json?.success && json.data) {
        setIdentity(json.data);
      }
    } finally {
      setIdentityLoading(false);
    }
  }, [userId, withPreviewScope]);

  const loadAccess = useCallback(async () => {
    setAccessError(null);
    setAccessLoading(true);
    try {
      const res = await fetch(
        withPreviewScope(`/api/admin/users/${encodeURIComponent(userId)}/access`),
      );
      const json = (await readJson(res)) as {
        success?: boolean;
        data?: { access?: AccessGroups };
        error?: string;
      } | null;
      if (!res.ok || !json?.success || !json.data?.access) {
        throw new Error(json?.error || `Failed to load access (${res.status})`);
      }
      setAccess(json.data.access);
    } catch (e) {
      setAccessError(e instanceof Error ? e.message : "Failed to load access");
      setAccess(null);
    } finally {
      setAccessLoading(false);
    }
  }, [userId, withPreviewScope]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setTeamsExpanded(false);
  }, [userId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Fire all three loads in parallel — each section shows its own spinner
  // rather than blocking the whole modal behind one top-level spinner.
  useEffect(() => {
    let cancelled = false;

    setProfileLoading(true);
    setProfileError(null);
    setUser(null);
    setAccess(null);
    setAccessLoading(true);
    setAccessError(null);
    setIdentity(null);
    setIdentityLoading(true);
    if (!readOnly && !teamOptionsProp) setTeamOptionsLoading(true);

    refreshProfile()
      .catch((e) => {
        if (!cancelled)
          setProfileError(e instanceof Error ? e.message : "Load failed");
      })
      .finally(() => {
        if (!cancelled) setProfileLoading(false);
      });

    if (!readOnly && !teamOptionsProp) {
      loadTeams().finally(() => {
        if (!cancelled) setTeamOptionsLoading(false);
      });
    }

    loadAccess();
    loadIdentity();

    return () => {
      cancelled = true;
    };
  }, [userId, readOnly, teamOptionsProp, refreshProfile, loadTeams, loadAccess, loadIdentity]);

  const runAction = useCallback(
    async (key: string, fn: () => Promise<void>, opts?: { refreshSession?: boolean }) => {
      setActionError(null);
      setBusy(key);
      try {
        await fn();
        await refreshProfile();
        void loadAccess();
        onSaved();
        if (opts?.refreshSession) {
          void updateSession({ forceRefresh: true });
        }
      } catch (e) {
        setActionError(e instanceof Error ? e.message : "Request failed");
      } finally {
        setBusy(null);
      }
    },
    [refreshProfile, loadAccess, onSaved, updateSession]
  );

  const fullName = useMemo(() => {
    if (!user) return "";
    const a = user.firstName.trim();
    const b = user.lastName.trim();
    const combined = `${a} ${b}`.trim();
    return combined || user.username || user.email || "User";
  }, [user]);

  const initials = useMemo(() => {
    if (!user) return "?";
    const parts = [user.firstName.trim(), user.lastName.trim()].filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    if (parts.length === 1 && parts[0].length >= 2) {
      return parts[0].slice(0, 2).toUpperCase();
    }
    const src = user.email || user.username || "?";
    const alnum = src.replace(/[^a-zA-Z0-9]/g, "");
    return (alnum.slice(0, 2) || "?").toUpperCase();
  }, [user]);

  const memberTeamIds = useMemo(() => {
    const s = new Set<string>();
    for (const t of user?.teams ?? []) s.add(t.team_id);
    return s;
  }, [user?.teams]);

  const teams = user?.teams ?? [];
  const visibleTeams = teamsExpanded ? teams : teams.slice(0, TEAM_COLLAPSED_LIMIT);
  const hiddenTeamCount = teams.length - visibleTeams.length;

  const addableTeams = useMemo(() => {
    return teamOptions.filter((t) => !memberTeamIds.has(t.teamId));
  }, [teamOptions, memberTeamIds]);

  const idpLabel = useMemo(() => {
    const feds = identity?.federatedIdentities ?? [];
    if (feds.length === 0) return "Local";
    return feds.map((f) => f.identityProvider).join(", ") || "Local";
  }, [identity?.federatedIdentities]);

  const accessTotal = useMemo(() => {
    if (!access) return 0;
    return ACCESS_GROUP_LABELS.reduce(
      (sum, { key }) => sum + (access[key]?.length ?? 0),
      0
    );
  }, [access]);

  const slackUserId = user?.attributes?.slack_user_id?.[0]?.trim() ?? "";
  const webexUserId = user?.attributes?.webex_user_id?.[0]?.trim() ?? "";
  const webexUserEmail = user?.attributes?.webex_user_email?.[0]?.trim() ?? "";
  const webexLinked = webexUserId.length > 0;

  const lastLoginLabel =
    identity?.lastAccess != null && identity.lastAccess > 0
      ? formatTs(identity.lastAccess)
      : "Never";

  const createdLabel =
    user?.createdAt != null && user.createdAt > 0
      ? formatTs(user.createdAt)
      : "—";

  const toggleEnabled = () => {
    if (!user) return;
    const next = !user.enabled;
    void runAction("enabled", async () => {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const json = (await readJson(res)) as { success?: boolean; error?: string };
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || `Update failed (${res.status})`);
      }
    }, { refreshSession: true });
  };

  const removeTeam = (teamId: string) => {
    void runAction(`team-del-${teamId}`, async () => {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(userId)}/teams`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ teamId }),
        }
      );
      const json = (await readJson(res)) as { success?: boolean; error?: string };
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || `Remove team failed (${res.status})`);
      }
    });
  };

  const addTeam = (teamId: string) => {
    if (!teamId) return;
    void runAction(`team-add-${teamId}`, async () => {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(userId)}/teams`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ teamId }),
        }
      );
      const json = (await readJson(res)) as { success?: boolean; error?: string };
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || `Add team failed (${res.status})`);
      }
    });
  };

  const unlinkSlack = () => {
    if (!user || user.slackLinkStatus !== "linked") return;
    if (!window.confirm("Remove Slack link for this user?")) return;
    void runAction("slack-unlink", async () => {
      const res = await fetch(`/api/admin/slack/users/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
      const json = (await readJson(res)) as { success?: boolean; error?: string };
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || `Unlink Slack failed (${res.status})`);
      }
    });
  };

  const unlinkWebex = () => {
    if (!user || !webexLinked) return;
    if (!window.confirm("Remove Webex link for this user?")) return;
    void runAction("webex-unlink", async () => {
      const res = await fetch(`/api/admin/webex/users/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
      const json = (await readJson(res)) as { success?: boolean; error?: string };
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || `Unlink Webex failed (${res.status})`);
      }
    });
  };

  const modalInner = (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="bg-card text-card-foreground border border-border rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-detail-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        {profileLoading ? (
          <div className="flex items-center gap-3 pb-4 border-b border-border">
            <div className="h-12 w-12 shrink-0 rounded-full bg-muted animate-pulse" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-40 rounded bg-muted animate-pulse" />
              <div className="h-3 w-56 rounded bg-muted animate-pulse" />
            </div>
          </div>
        ) : profileError ? (
          <div className="space-y-4">
            <p className="text-sm text-destructive">{profileError}</p>
            <button
              type="button"
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        ) : user ? (
          <>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between border-b border-border pb-4">
              <div className="flex items-start gap-3 min-w-0">
                <div
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground"
                  aria-hidden
                >
                  {initials}
                </div>
                <div className="min-w-0">
                  <h2
                    id="user-detail-modal-title"
                    className="text-lg font-semibold truncate"
                  >
                    {fullName}
                  </h2>
                  <p className="text-sm text-muted-foreground truncate">{user.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-sm text-muted-foreground">Account</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={user.enabled}
                  disabled={readOnly || busy === "enabled"}
                  onClick={() => toggleEnabled()}
                  className={`relative inline-flex h-7 w-12 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-neutral-400 ${
                    user.enabled ? "bg-emerald-500" : "bg-muted"
                  } ${readOnly || busy === "enabled" ? "opacity-60 cursor-not-allowed" : ""}`}
                >
                  <span
                    className={`pointer-events-none absolute left-1 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-white shadow transition-transform ${
                      user.enabled ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
                <span className="text-sm font-medium text-foreground">
                  {user.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
            </div>

            {actionError ? (
              <p className="mt-4 text-sm text-destructive" role="alert">
                {actionError}
              </p>
            ) : null}

            <section className="mt-6 border-t border-border pt-6">
              <div className="mb-3 flex items-center justify-between gap-3">
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-md text-left text-sm font-semibold text-foreground hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  aria-expanded={teamsExpanded}
                  aria-controls="user-detail-teams-list"
                  disabled={teams.length <= TEAM_COLLAPSED_LIMIT}
                  onClick={() => setTeamsExpanded((prev) => !prev)}
                >
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${
                      teamsExpanded ? "rotate-0" : "-rotate-90"
                    } ${teams.length <= TEAM_COLLAPSED_LIMIT ? "opacity-0" : ""}`}
                    aria-hidden
                  />
                  <span>Teams</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {teams.length}
                  </span>
                </button>
                {teams.length > TEAM_COLLAPSED_LIMIT ? (
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10"
                    onClick={() => setTeamsExpanded((prev) => !prev)}
                  >
                    {teamsExpanded ? "Collapse" : `Show ${hiddenTeamCount} more`}
                  </button>
                ) : null}
              </div>
              <div id="user-detail-teams-list" className="mb-3 flex flex-wrap gap-2">
                {teams.length === 0 ? (
                  <span className="text-sm text-muted-foreground">No teams</span>
                ) : (
                  visibleTeams.map((t) => (
                    <span
                      key={`${t.team_id}:${t.tenant_id}`}
                      className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-medium text-foreground"
                    >
                      {t.team_id}
                      <span className="text-muted-foreground font-normal">
                        ({t.tenant_id})
                      </span>
                      {!readOnly && (
                        <button
                          type="button"
                          className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                          aria-label={`Remove team ${t.team_id}`}
                          disabled={busy != null}
                          onClick={() => removeTeam(t.team_id)}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))
                )}
                {hiddenTeamCount > 0 ? (
                  <span className="inline-flex items-center rounded-full border border-dashed border-border px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                    +{hiddenTeamCount} more
                  </span>
                ) : null}
              </div>
              {!readOnly && (
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor="add-team" className="text-sm text-muted-foreground">
                    Add team
                  </label>
                  {teamOptionsLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
                  ) : (
                    <TeamPicker
                      id="add-team"
                      value={addTeamValue}
                      onChange={(v) => {
                        if (!v) return;
                        addTeam(v);
                        setAddTeamValue("");
                      }}
                      disabled={busy != null || addableTeams.length === 0}
                      placeholder={addableTeams.length === 0 ? "No teams to add" : "Select a team…"}
                      searchPlaceholder="Search teams..."
                      triggerClassName="min-w-[12rem]"
                      options={addableTeams.map<TeamPickerOption>((t) => ({
                        slug: t.teamId,
                        name: t.label,
                      }))}
                    />
                  )}
                </div>
              )}
            </section>

            <section className="mt-6 border-t border-border pt-6">
              <div className="flex items-baseline justify-between mb-3">
                <h3 className="text-sm font-semibold text-foreground">Access</h3>
                <span className="text-xs text-muted-foreground">
                  Effective permissions
                </span>
              </div>
              {accessLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  <span>Resolving access…</span>
                </div>
              ) : accessError ? (
                <p className="text-sm text-destructive">{accessError}</p>
              ) : !access || accessTotal === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No resource access. Access is granted by adding this user to a
                  team that owns agents, tools, or knowledge bases.
                </p>
              ) : (
                <div className="space-y-4">
                  {ACCESS_GROUP_LABELS.map(({ key, label }) => {
                    const items = access[key] ?? [];
                    if (items.length === 0) return null;
                    return <AccessGroupList key={key} label={label} items={items} />;
                  })}
                </div>
              )}
            </section>

            <section className="mt-6 border-t border-border pt-6">
              <h3 className="text-sm font-semibold text-foreground mb-3">
                Identity & account
              </h3>
              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
                <div>
                  <dt className="text-muted-foreground">IdP source</dt>
                  <dd className="font-medium text-foreground mt-0.5">
                    {identityLoading ? (
                      <span className="inline-block h-3 w-16 rounded bg-muted animate-pulse" />
                    ) : idpLabel}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Slack</dt>
                  <dd className="mt-0.5">
                    {user.slackLinkStatus === "linked" ? (
                      <span className="inline-flex flex-col gap-2">
                        <span className="inline-flex flex-wrap items-center gap-2">
                          <span className="inline-flex items-center w-fit rounded-full bg-emerald-500/15 text-emerald-400 px-2 py-0.5 text-xs font-medium">
                            Linked
                          </span>
                          {!readOnly && (
                            <button
                              type="button"
                              disabled={busy === "slack-unlink"}
                              onClick={() => unlinkSlack()}
                              className="rounded-md border border-destructive/40 px-2 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:cursor-wait disabled:opacity-60"
                            >
                              {busy === "slack-unlink" ? "Unlinking…" : "Unlink Slack"}
                            </button>
                          )}
                        </span>
                        {slackUserId ? (
                          <span className="font-mono text-xs text-muted-foreground">{slackUserId}</span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-xs font-medium">
                        Unlinked
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Webex</dt>
                  <dd className="mt-0.5">
                    {webexLinked ? (
                      <span className="inline-flex flex-col gap-2">
                        <span className="inline-flex flex-wrap items-center gap-2">
                          <span className="inline-flex items-center w-fit rounded-full bg-emerald-500/15 text-emerald-400 px-2 py-0.5 text-xs font-medium">
                            Linked
                          </span>
                          {!readOnly && (
                            <button
                              type="button"
                              disabled={busy === "webex-unlink"}
                              onClick={() => unlinkWebex()}
                              className="rounded-md border border-destructive/40 px-2 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:cursor-wait disabled:opacity-60"
                            >
                              {busy === "webex-unlink" ? "Unlinking…" : "Unlink Webex"}
                            </button>
                          )}
                        </span>
                        {webexUserEmail ? (
                          <span className="text-xs text-muted-foreground">{webexUserEmail}</span>
                        ) : webexUserId ? (
                          <span className="font-mono text-xs text-muted-foreground">{webexUserId}</span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-xs font-medium">
                        Unlinked
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Last login</dt>
                  <dd className="font-medium text-foreground mt-0.5">
                    {identityLoading ? (
                      <span className="inline-block h-3 w-24 rounded bg-muted animate-pulse" />
                    ) : lastLoginLabel}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Account created</dt>
                  <dd className="font-medium text-foreground mt-0.5">
                    {createdLabel}
                  </dd>
                </div>
              </dl>
            </section>

            <div className="mt-8 flex justify-end gap-2 border-t border-border pt-4">
              <button
                type="button"
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
                onClick={onClose}
              >
                Close
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );

  if (!mounted) return null;

  return createPortal(modalInner, document.body);
}
