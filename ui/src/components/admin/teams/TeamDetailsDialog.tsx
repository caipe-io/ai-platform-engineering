"use client";

import { getErrorMessage } from "@/lib/error-utils";

import { IngestCapabilityToggle } from "@/components/admin/shared/IngestCapabilityToggle";
import { SaveButton } from "@/components/admin/shared/SaveButton";
import { SearchCapabilityToggle } from "@/components/admin/shared/SearchCapabilityToggle";
import { TeamKbAssignmentPanel } from "@/components/admin/teams/TeamKbAssignmentPanel";
import { Badge } from "@/components/ui/badge";
import {
  BuiltInResourceHint,
  builtInTeamHelpText,
} from "@/components/ui/built-in-resource-hint";
import { Button } from "@/components/ui/button";
import {
Dialog,
DialogContent,
DialogDescription,
DialogFooter,
DialogHeader,
DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { TeamMembershipSource } from "@/types/identity-group-sync";
import type { Team } from "@/types/teams";
import {
Check,
ChevronLeft,
ChevronRight,
Clock3,
Crown,
Hash,
Loader2,
Lock,
MessageSquare,
Pencil,
RefreshCw,
Search,
Shield,
ShieldAlert,
ShieldCheck,
ShieldQuestion,
Trash2,
User,
UserPlus,
X,
} from "lucide-react";
import React,{ useCallback,useEffect,useRef,useState } from "react";

// Per-member access-sync state, delivered as `sync_status` on each row of the
// paginated members list and shown as a small badge in the Members tab.
type TeamMembershipSyncState = "synced" | "pending" | "drifted" | "unknown";

export type DialogMode =
  | "details"
  | "members"
  | "resources"
  | "mcp"
  | "skills"
  | "workflows"
  | "kbs"
  | "channels"
  | "webex";

interface ResourceOption {
  id: string;
  name: string;
  description?: string;
}

/** Read-only resource grant (workflows, skills) surfaced with a resolved name. */
interface NamedResource {
  id: string;
  name: string;
  description?: string;
}

interface ResourcesPayload {
  resources: {
    agents: string[];
    agent_admins: string[];
    tools: string[];
    tool_wildcard: boolean;
    // Read-only grants surfaced for visibility; not editable from this dialog.
    // Workflows are shared from the workflow editor, skills from the skill
    // editor — each has its own single writer.
    workflows?: NamedResource[];
    skills?: NamedResource[];
  };
  available: { agents: ResourceOption[]; tools: ResourceOption[] };
}

// Spec 098 US9 — Slack channels tab.
interface TeamSlackChannel {
  slack_channel_id: string;
  channel_name: string;
  slack_workspace_id?: string;
}

interface SlackChannelsPayload {
  team_id: string;
  channels: TeamSlackChannel[];
}

interface TeamWebexSpace {
  bot_id?: string;
  webex_space_id: string;
  space_name: string;
  webex_workspace_id?: string;
}

interface WebexSpacesPayload {
  team_id: string;
  spaces: TeamWebexSpace[];
}

// One row of the paginated member list (GET /api/admin/teams/[id]/members).
interface TeamMemberPageRow {
  identity_key: string;
  user_subject?: string;
  user_email?: string;
  role: "owner" | "admin" | "member";
  source_types: TeamMembershipSource["source_type"][];
  idp_managed: boolean;
  added_at?: string;
  // Per-member OpenFGA sync state, computed page-scoped by the members
  // endpoint (only the visible subjects are read, never the whole team).
  sync_status?: TeamMembershipSyncState;
  sync_reason?: string;
}

interface TeamMembersPagePayload {
  members: TeamMemberPageRow[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

const TEAM_MEMBERS_PAGE_SIZE = 4;

interface TeamDetailsDialogProps {
  team: Team | null;
  mode: DialogMode;
  open: boolean;
  canManageOrganization?: boolean;
  onOpenChange: (open: boolean) => void;
  onTeamUpdated: () => void;
  /**
   * Lightweight callback for in-modal mutations (add/remove member, edit
   * details). When provided, the parent receives the updated Team payload
   * and is expected to patch its local `teams[]` state in place — avoiding
   * a full admin-page reload (which otherwise blanks the dashboard).
   *
   * When omitted, the dialog falls back to `onTeamUpdated()` for backwards
   * compatibility.
   */
  onTeamMutated?: (team: Team) => void;
}

function getRoleIcon(role: string) {
  switch (role) {
    case "owner":
      return <Crown className="h-3.5 w-3.5 text-yellow-500" />;
    case "admin":
      return <Shield className="h-3.5 w-3.5 text-blue-500" />;
    default:
      return <User className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function getRoleBadgeVariant(role: string) {
  switch (role) {
    case "owner":
      return "default" as const;
    case "admin":
      return "secondary" as const;
    default:
      return "outline" as const;
  }
}

function getSourceLabel(sourceType: TeamMembershipSource["source_type"]): string {
  if (sourceType === "manual") return "Manual";
  if (sourceType === "oidc_claim") return "OIDC claim";
  if (sourceType === "active_directory") return "AD";
  if (sourceType === "okta") return "Okta";
  return sourceType.replace(/_/g, " ");
}

function getSourceBadgeVariant(sourceType: TeamMembershipSource["source_type"]) {
  // Members from the paginated list are always active; only the manual source
  // gets the filled "secondary" treatment, IdP sources get the "outline".
  return sourceType === "manual" ? ("secondary" as const) : ("outline" as const);
}

// Render-helpers for the OpenFGA sync diagnostic. Kept colocated so the
// badge and the banner agree on colour/icon/label.

function syncBadgeAppearance(status: TeamMembershipSyncState): {
  variant: "default" | "secondary" | "outline" | "destructive";
  icon: React.ReactNode;
  label: string;
} {
  switch (status) {
    case "synced":
      return {
        variant: "outline",
        icon: <ShieldCheck className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />,
        label: "OpenFGA: synced",
      };
    case "drifted":
      return {
        variant: "destructive",
        icon: <ShieldAlert className="h-3 w-3" />,
        label: "OpenFGA: drifted",
      };
    case "pending":
      return {
        variant: "secondary",
        icon: <Clock3 className="h-3 w-3" />,
        label: "OpenFGA: pending",
      };
    case "unknown":
    default:
      return {
        variant: "outline",
        icon: <ShieldQuestion className="h-3 w-3 text-muted-foreground" />,
        label: "OpenFGA: unknown",
      };
  }
}

export function TeamDetailsDialog({
  team,
  mode,
  open,
  canManageOrganization = false,
  onOpenChange,
  onTeamUpdated,
  onTeamMutated,
}: TeamDetailsDialogProps) {
  const [activeMode, setActiveMode] = useState<DialogMode>(mode);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Edit team fields
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");

  // Add member fields
  const [newMemberEmail, setNewMemberEmail] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<"member" | "admin">("member");
  const [addingMember, setAddingMember] = useState(false);

  // Spec 098 — Keycloak user typeahead for Add Member. We hit
  // /api/admin/users?search=<q> (server-side Keycloak search) once the
  // admin has typed at least 2 characters, debounced to 200ms so we
  // don't spam the realm. The dropdown is opt-in — pressing Enter or
  // clicking Add still POSTs the raw input verbatim (the backend
  // accepts an email and resolves the Keycloak subject itself), so
  // typing a full email of a not-yet-provisioned user still works.
  const [memberSearchResults, setMemberSearchResults] = useState<
    Array<{ id: string; email: string; firstName?: string; lastName?: string; username?: string }>
  >([]);
  const [memberSearchLoading, setMemberSearchLoading] = useState(false);
  const [memberSearchOpen, setMemberSearchOpen] = useState(false);
  const memberSearchAbortRef = useRef<AbortController | null>(null);

  // Removing member.
  //   `pendingRemoveMember` — user clicked the trash icon and is being shown
  //     the inline confirm row, but hasn't confirmed yet (no API call in
  //     flight). Replaces the previous window.confirm() blocking prompt,
  //     which broke the in-modal UX by hijacking the entire tab.
  //   `removingMember` — request is actually in flight; row shows a spinner
  //     and the trash button is disabled.
  const [pendingRemoveMember, setPendingRemoveMember] = useState<string | null>(
    null,
  );
  const [removingMember, setRemovingMember] = useState<string | null>(null);

  // Paginated member list (GET /api/admin/teams/[id]/members). The Members tab
  // renders from this — NOT from the full `membershipSources` array — so a team
  // with a very large roster loads one page at a time instead of all at once.
  // `memberSearch` is debounced into a server-side email filter.
  const [memberPage, setMemberPage] = useState<TeamMemberPageRow[]>([]);
  const [memberTotal, setMemberTotal] = useState(0);
  const [memberPageNum, setMemberPageNum] = useState(1);
  const [memberSearch, setMemberSearch] = useState("");
  const [membersLoading, setMembersLoading] = useState(false);

  // Spec 104 — Resources tab state
  const [resourcesData, setResourcesData] = useState<ResourcesPayload | null>(null);
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [selectedAgentAdmins, setSelectedAgentAdmins] = useState<Set<string>>(new Set());
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const [toolWildcard, setToolWildcard] = useState(false);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [resourcesSaving, setResourcesSaving] = useState(false);
  const [resourcesNotice, setResourcesNotice] = useState<string | null>(null);
  const resourcesLoadedTeamIdRef = useRef<string | null>(null);

  // Spec 098 US9 — Slack channels tab state
  const [channelsData, setChannelsData] = useState<SlackChannelsPayload | null>(null);
  const [editedChannels, setEditedChannels] = useState<TeamSlackChannel[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [channelsSaving, setChannelsSaving] = useState(false);
  const [channelsNotice, setChannelsNotice] = useState<string | null>(null);

  const [webexSpacesData, setWebexSpacesData] = useState<WebexSpacesPayload | null>(null);
  const [editedWebexSpaces, setEditedWebexSpaces] = useState<TeamWebexSpace[]>([]);
  const [webexSpacesLoading, setWebexSpacesLoading] = useState(false);
  const [webexSpacesSaving, setWebexSpacesSaving] = useState(false);
  const [webexSpacesNotice, setWebexSpacesNotice] = useState<string | null>(null);

  // Current team data (may be refreshed after mutations)
  const [currentTeam, setCurrentTeam] = useState<Team | null>(team);

  useEffect(() => {
    if (open && team) {
      setCurrentTeam(team);
      setActiveMode(mode);
      setIsEditing(false);
      setEditName(team.name);
      setEditDescription(team.description || "");
      setError(null);
      setNewMemberEmail("");
      setNewMemberRole("member");
      setMemberSearchResults([]);
      setMemberSearchLoading(false);
      setMemberSearchOpen(false);
      setPendingRemoveMember(null);
      setMemberPage([]);
      setMemberTotal(0);
      setMemberPageNum(1);
      setMemberSearch("");
      setMembersLoading(false);
      setResourcesData(null);
      resourcesLoadedTeamIdRef.current = null;
      setResourcesNotice(null);
      setChannelsData(null);
      setEditedChannels([]);
      setChannelsNotice(null);
      setWebexSpacesData(null);
      setEditedWebexSpaces([]);
      setWebexSpacesNotice(null);
    }
  }, [open, team, mode]);

  // Debounced typeahead against the Keycloak realm. We require ≥2
  // characters to avoid sending broad regex scans on every keystroke.
  // Cancellation is best-effort via AbortController — Keycloak rarely
  // takes long enough for this to matter, but it keeps stale results
  // from clobbering newer ones when the admin types quickly.
  useEffect(() => {
    if (!open || activeMode !== "members" || currentTeam?.can_manage !== true) return;
    const query = newMemberEmail.trim();
    if (query.length < 2) {
      setMemberSearchResults([]);
      setMemberSearchLoading(false);
      return;
    }
    const handle = setTimeout(() => {
      memberSearchAbortRef.current?.abort();
      const ctrl = new AbortController();
      memberSearchAbortRef.current = ctrl;
      setMemberSearchLoading(true);
      const params = new URLSearchParams({ search: query, pageSize: "8" });
      fetch(`/api/admin/users?${params.toString()}`, { signal: ctrl.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`User search failed: ${res.status}`);
          return res.json();
        })
        .then((payload) => {
          if (ctrl.signal.aborted) return;
          const users = Array.isArray(payload?.users) ? payload.users : [];
          setMemberSearchResults(
            users
              .filter((u: { email?: string }) => Boolean(u?.email))
              .map((u: { id: string; email: string; firstName?: string; lastName?: string; username?: string }) => ({
                id: String(u.id),
                email: String(u.email),
                firstName: u.firstName,
                lastName: u.lastName,
                username: u.username,
              }))
          );
        })
        .catch((err: unknown) => {
          if ((err as { name?: string })?.name === "AbortError") return;
          // Keep the previous results so the dropdown doesn't flicker;
          // search failures are logged but not surfaced inline so they
          // don't crowd the small Add-Member panel.
          console.warn("[TeamDetails] Member search failed:", err);
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setMemberSearchLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(handle);
    };
  }, [open, activeMode, currentTeam?.can_manage, newMemberEmail]);

  // Membership sources are loaded together with openfga_sync from the
  // canonical GET /api/admin/teams/[id] effect above — no separate fetch.

  // Spec 104 — load the resources catalog the first time the user opens
  // the tab for a given team. We refetch on every open of the tab so the
  // picker reflects newly-created agents/MCP servers without requiring a
  // dialog close.
  useEffect(() => {
    // The read-only Skills & Workflows tabs are served by the same resources
    // endpoint as the editable Agents and MCP tabs, so load for all of them.
    const usesResourcesEndpoint =
      activeMode === "resources" ||
      activeMode === "mcp" ||
      activeMode === "skills" ||
      activeMode === "workflows";
    if (!open || !usesResourcesEndpoint || !currentTeam) return;
    if (resourcesLoadedTeamIdRef.current === currentTeam._id && resourcesData) return;
    let cancelled = false;
    setResourcesLoading(true);
    setError(null);
    setResourcesNotice(null);
    fetch(`/api/admin/teams/${currentTeam._id}/resources`)
      .then(async (res) => {
        const data = await res.json();
        if (!data.success) {
          throw new Error(data.error || "Failed to load agents and MCP access");
        }
        if (!cancelled) {
          const payload = data.data as ResourcesPayload;
          setResourcesData(payload);
          setSelectedAgents(new Set(payload.resources.agents ?? []));
          setSelectedAgentAdmins(new Set(payload.resources.agent_admins ?? []));
          setSelectedTools(new Set(payload.resources.tools ?? []));
          setToolWildcard(Boolean(payload.resources.tool_wildcard));
          resourcesLoadedTeamIdRef.current = currentTeam._id;
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? getErrorMessage(err, "") : "Failed to load agents and MCP access");
        }
      })
      .finally(() => {
        if (!cancelled) setResourcesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeMode, currentTeam, resourcesData]);

  // Spec 098 US9 — load this team's channel assignments + bindable agents
  // when the Slack Channels tab opens. Mirrors the resources tab:
  // refetch on every open so newly-added agents show up in the bind dropdown
  // without a dialog close cycle.
  useEffect(() => {
    if (!open || activeMode !== "channels" || !currentTeam) return;
    let cancelled = false;
    setChannelsLoading(true);
    setError(null);
    setChannelsNotice(null);
    fetch(`/api/admin/teams/${currentTeam._id}/slack-channels`)
      .then(async (res) => {
        const data = await res.json();
        if (!data.success) {
          throw new Error(data.error || "Failed to load channels");
        }
        if (!cancelled) {
          const payload = data.data as SlackChannelsPayload;
          setChannelsData(payload);
          // Clone for edit so we don't mutate the canonical payload until
          // the admin clicks Save.
          setEditedChannels(payload.channels.map((c) => ({ ...c })));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? getErrorMessage(err, "") : "Failed to load channels");
        }
      })
      .finally(() => {
        if (!cancelled) setChannelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeMode, currentTeam]);

  useEffect(() => {
    if (!open || activeMode !== "webex" || !currentTeam) return;
    let cancelled = false;
    setWebexSpacesLoading(true);
    setError(null);
    setWebexSpacesNotice(null);
    fetch(`/api/admin/teams/${currentTeam._id}/webex-spaces`)
      .then(async (res) => {
        const data = await res.json();
        if (!data.success) {
          throw new Error(data.error || "Failed to load Webex spaces");
        }
        if (!cancelled) {
          const payload = data.data as WebexSpacesPayload;
          setWebexSpacesData(payload);
          setEditedWebexSpaces(payload.spaces.map((s) => ({ ...s })));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? getErrorMessage(err, "") : "Failed to load Webex spaces");
        }
      })
      .finally(() => {
        if (!cancelled) setWebexSpacesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeMode, currentTeam]);

  const handleRemoveChannel = (id: string) => {
    setEditedChannels((prev) => prev.filter((c) => c.slack_channel_id !== id));
  };

  const handleSaveChannels = async () => {
    if (!currentTeam || currentTeam.can_manage !== true) return;
    setChannelsSaving(true);
    setError(null);
    setChannelsNotice(null);
    try {
      const res = await fetch(`/api/admin/teams/${currentTeam._id}/slack-channels`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channels: editedChannels }),
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to save channels");
      }
      const removed: string[] = data.data?.removed_channel_ids ?? [];
      setChannelsNotice(
        removed.length > 0
          ? `Saved. ${editedChannels.length} channel(s) active; ${removed.length} removed.`
          : `Saved. ${editedChannels.length} channel(s) assigned.`
      );
      // Refresh canonical state so the next edit starts from the saved snapshot.
      setChannelsData((prev) =>
        prev ? { ...prev, channels: editedChannels.map((c) => ({ ...c })) } : prev
      );
      onTeamUpdated();
    } catch (err) {
      setError(err instanceof Error ? getErrorMessage(err, "") : "Failed to save channels");
    } finally {
      setChannelsSaving(false);
    }
  };

  const handleRemoveWebexSpace = (id: string) => {
    setEditedWebexSpaces((prev) => prev.filter((s) => s.webex_space_id !== id));
  };

  const handleSaveWebexSpaces = async () => {
    if (!currentTeam || currentTeam.can_manage !== true) return;
    setWebexSpacesSaving(true);
    setError(null);
    setWebexSpacesNotice(null);
    try {
      const res = await fetch(`/api/admin/teams/${currentTeam._id}/webex-spaces`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spaces: editedWebexSpaces }),
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to save Webex spaces");
      }
      const removed: string[] = data.data?.removed_space_ids ?? [];
      setWebexSpacesNotice(
        removed.length > 0
          ? `Saved. ${editedWebexSpaces.length} space(s) active; ${removed.length} removed.`
          : `Saved. ${editedWebexSpaces.length} space(s) assigned.`
      );
      setWebexSpacesData((prev) =>
        prev ? { ...prev, spaces: editedWebexSpaces.map((s) => ({ ...s })) } : prev
      );
      onTeamUpdated();
    } catch (err) {
      setError(err instanceof Error ? getErrorMessage(err, "") : "Failed to save Webex spaces");
    } finally {
      setWebexSpacesSaving(false);
    }
  };

  function toggleSet(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const toggleAgent = (id: string) => toggleSet(setSelectedAgents, id);
  const toggleAgentAdmin = (id: string) => toggleSet(setSelectedAgentAdmins, id);
  const toggleTool = (id: string) => toggleSet(setSelectedTools, id);

  const handleSaveResources = async () => {
    if (!currentTeam || currentTeam.can_manage !== true) return;
    setResourcesSaving(true);
    setError(null);
    setResourcesNotice(null);
    try {
      const res = await fetch(`/api/admin/teams/${currentTeam._id}/resources`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agents: Array.from(selectedAgents),
          agent_admins: Array.from(selectedAgentAdmins),
          tools: Array.from(selectedTools),
          tool_wildcard: toolWildcard,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to save agents and MCP access");
      }
      // Resource grants are keyed on the team userset, so saving touches only
      // the team's resource tuples — member access resolves transitively from
      // their existing team membership (owned by the members tab), nothing to
      // report per-member here.
      setResourcesNotice("Saved.");
      onTeamUpdated();
    } catch (err) {
      setError(err instanceof Error ? getErrorMessage(err, "") : "Failed to save agents and MCP access");
    } finally {
      setResourcesSaving(false);
    }
  };

  // Re-fetch the canonical team document plus its membership sources and
  // OpenFGA sync diagnostic. We do this after Add/Remove member (otherwise
  // the badges that read from `membership_sources` and `openfga_sync`
  // would stay stale until the dialog is reopened) and from the explicit
  // "Refresh" button in the dialog header.
  const [refreshingTeam, setRefreshingTeam] = useState(false);
  const refreshTeam = useCallback(async () => {
    if (!currentTeam) return;
    setRefreshingTeam(true);
    try {
      const res = await fetch(`/api/admin/teams/${currentTeam._id}`);
      if (!res.ok) {
        throw new Error(`Failed to refresh team (HTTP ${res.status})`);
      }
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to refresh team");
      }
      const payload = data.data ?? {};
      if (payload.team) {
        setCurrentTeam((previous) => ({
          ...payload.team,
          can_manage: previous?.can_manage === true,
        }));
      }
    } catch (err) {
      console.error("[TeamDetails] Failed to refresh team:", err);
      setError(err instanceof Error ? getErrorMessage(err, "") : "Failed to refresh team");
    } finally {
      setRefreshingTeam(false);
    }
  }, [currentTeam]);

  // Fetch one page of the member list from the server. Search is applied
  // server-side (email substring) so the browser only ever holds a page of
  // members regardless of roster size.
  const fetchMembersPage = useCallback(
    async (teamId: string, page: number, search: string) => {
      setMembersLoading(true);
      try {
        const params = new URLSearchParams({
          page: String(page),
          page_size: String(TEAM_MEMBERS_PAGE_SIZE),
        });
        if (search.trim()) params.set("search", search.trim());
        const res = await fetch(
          `/api/admin/teams/${teamId}/members?${params.toString()}`,
        );
        const data = await res.json();
        if (!data.success) {
          throw new Error(data.error || `Failed to load members (${res.status})`);
        }
        const payload = data.data as TeamMembersPagePayload;
        setMemberPage(payload.members ?? []);
        setMemberTotal(payload.total ?? 0);
        setMemberPageNum(payload.page ?? page);
      } catch (err: unknown) {
        console.error("[TeamDetails] Failed to load members:", err);
        setError(err instanceof Error ? getErrorMessage(err, "") : "Failed to load members");
      } finally {
        setMembersLoading(false);
      }
    },
    [],
  );

  // Load + debounced search for the Members tab. Typing resets to page 1 and
  // re-queries the server (~250ms after the last keystroke). Only runs while
  // the Members tab is active so other tabs don't trigger member queries.
  useEffect(() => {
    if (!open || activeMode !== "members" || !currentTeam?._id) return;
    const teamId = currentTeam._id;
    const handle = setTimeout(() => {
      void fetchMembersPage(teamId, 1, memberSearch);
    }, 250);
    return () => clearTimeout(handle);
  }, [open, activeMode, currentTeam?._id, memberSearch, fetchMembersPage]);

  const memberTotalPages = Math.max(1, Math.ceil(memberTotal / TEAM_MEMBERS_PAGE_SIZE));
  const memberHasMore = memberPageNum * TEAM_MEMBERS_PAGE_SIZE < memberTotal;
  const goToMembersPage = (page: number) => {
    if (!currentTeam?._id) return;
    const clamped = Math.min(Math.max(1, page), memberTotalPages);
    void fetchMembersPage(currentTeam._id, clamped, memberSearch);
  };
  // Re-fetch the current member page after an add/remove mutation.
  const reloadMembersPage = useCallback(() => {
    if (!currentTeam?._id) return;
    void fetchMembersPage(currentTeam._id, memberPageNum, memberSearch);
  }, [currentTeam?._id, fetchMembersPage, memberPageNum, memberSearch]);

  const handleSaveEdit = async () => {
    if (!currentTeam || currentTeam.can_manage !== true) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/admin/teams/${currentTeam._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          description: editDescription.trim(),
        }),
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to update team");
      }

      const updatedTeam = data.data.team as Team;
      setCurrentTeam({ ...updatedTeam, can_manage: true });
      setIsEditing(false);
      if (onTeamMutated) {
        onTeamMutated(updatedTeam);
      } else {
        onTeamUpdated();
      }
    } catch (err) {
      setError(getErrorMessage(err, "") || "Failed to update team");
    } finally {
      setLoading(false);
    }
  };

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentTeam || currentTeam.can_manage !== true || !newMemberEmail.trim()) return;

    setAddingMember(true);
    setError(null);

    try {
      const res = await fetch(`/api/admin/teams/${currentTeam._id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: newMemberEmail.trim(),
          role: newMemberRole,
        }),
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to add member");
      }

      const updatedTeam = data.data.team as Team;
      setCurrentTeam({ ...updatedTeam, can_manage: true });
      setNewMemberEmail("");
      setNewMemberRole("member");
      setMemberSearchResults([]);
      setMemberSearchOpen(false);
      // Reload the member page so the new member shows up, and refresh the
      // OpenFGA sync diagnostic (Details-tab banner) in the background.
      reloadMembersPage();
      void refreshTeam();
      // Prefer the lightweight callback so the parent admin page can
      // patch its `teams[]` state in place — no full dashboard reload,
      // no setLoading(true), no flicker. Fall back to onTeamUpdated()
      // only if the parent hasn't opted in.
      if (onTeamMutated) {
        onTeamMutated(updatedTeam);
      } else {
        onTeamUpdated();
      }
    } catch (err) {
      setError(getErrorMessage(err, "") || "Failed to add member");
    } finally {
      setAddingMember(false);
    }
  };

  const handlePickMemberFromSearch = (user: {
    email: string;
    firstName?: string;
    lastName?: string;
  }) => {
    setNewMemberEmail(user.email);
    setMemberSearchResults([]);
    setMemberSearchOpen(false);
  };

  const handleRemoveMember = async (email: string) => {
    if (!currentTeam || currentTeam.can_manage !== true) return;

    setRemovingMember(email);
    setPendingRemoveMember(null);
    setError(null);

    try {
      const res = await fetch(
        `/api/admin/teams/${currentTeam._id}/members?user_id=${encodeURIComponent(email)}`,
        { method: "DELETE" }
      );

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to remove member");
      }

      const updatedTeam = data.data.team as Team;
      setCurrentTeam({ ...updatedTeam, can_manage: true });
      // Optimistically drop the removed row, then reload the page so a member
      // from the next page backfills the slot and the total stays correct.
      setMemberPage((prev) =>
        prev.filter((m) => (m.user_email ?? "").toLowerCase() !== email.toLowerCase()),
      );
      setMemberTotal((prev) => Math.max(0, prev - 1));
      reloadMembersPage();
      void refreshTeam();
      if (onTeamMutated) {
        onTeamMutated(updatedTeam);
      } else {
        onTeamUpdated();
      }
    } catch (err) {
      setError(getErrorMessage(err, "") || "Failed to remove member");
    } finally {
      setRemovingMember(null);
    }
  };

  if (!currentTeam) return null;

  const canManageTeam = currentTeam.can_manage === true;
  const builtInHelp = builtInTeamHelpText(currentTeam.slug);
  const createdByLabel =
    currentTeam.created_by === "bootstrap" ? "System" : currentTeam.owner_id;

  // Member count for the tab/Details badges. Prefer the server total from the
  // paginated members endpoint once loaded; fall back to the count decorated
  // onto the team by GET /api/admin/teams before the first page loads.
  const memberCount = memberTotal || currentTeam.member_count || 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[680px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isEditing ? "Edit Team" : currentTeam.name}
            {!isEditing && builtInHelp && (
              <BuiltInResourceHint text={builtInHelp} />
            )}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update the team name and description"
              : currentTeam.description || "No description"}
          </DialogDescription>
        </DialogHeader>

        {/* Mode Tabs. The tab row can exceed the dialog width (many
            integrations), so it scrolls horizontally instead of spilling out
            of the box. `shrink-0` on each button keeps labels on one line. */}
        <div className="flex items-center gap-1 border-b pb-2 overflow-x-auto">
          <Button
            variant={activeMode === "details" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveMode("details")}
            className="text-xs shrink-0"
          >
            Details
          </Button>
          <Button
            variant={activeMode === "members" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveMode("members")}
            className="text-xs shrink-0"
          >
            Members
          </Button>
          <Button
            variant={activeMode === "resources" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveMode("resources")}
            className="text-xs shrink-0"
          >
            Agents
          </Button>
          <Button
            variant={activeMode === "mcp" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveMode("mcp")}
            className="text-xs shrink-0"
          >
            MCPs
          </Button>
          <Button
            variant={activeMode === "skills" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveMode("skills")}
            className="text-xs shrink-0"
          >
            Skills
          </Button>
          <Button
            variant={activeMode === "workflows" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveMode("workflows")}
            className="text-xs shrink-0"
          >
            Workflows
          </Button>
          <Button
            variant={activeMode === "kbs" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveMode("kbs")}
            className="text-xs shrink-0"
          >
            Knowledge Bases
          </Button>
          <Button
            variant={activeMode === "channels" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveMode("channels")}
            className="text-xs shrink-0"
          >
            Slack Channels
          </Button>
          <Button
            variant={activeMode === "webex" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveMode("webex")}
            className="text-xs shrink-0"
          >
            Webex Spaces
          </Button>
          {/* Refresh re-fetches the team document, membership sources,
              and OpenFGA sync diagnostic for this dialog. Useful when an
              admin suspects external state (e.g. an OIDC sync run) has
              changed the team since they opened the modal. */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refreshTeam()}
            disabled={refreshingTeam}
            className="ml-auto h-7 w-7 p-0 shrink-0"
            title="Refresh this team"
            aria-label="Refresh this team"
          >
            {refreshingTeam ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* Details Mode */}
        {activeMode === "details" && (
          <div className="space-y-4 py-2">
            {isEditing ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="editName">Team Name</Label>
                  <Input
                    id="editName"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    disabled={loading}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="editDesc">Description</Label>
                  <Textarea
                    id="editDesc"
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    disabled={loading}
                    rows={3}
                  />
                </div>
                <div className="flex gap-2">
                  <SaveButton
                    onSave={handleSaveEdit}
                    saving={loading}
                    dirty={
                      editName.trim() !== currentTeam.name ||
                      editDescription !== (currentTeam.description || "")
                    }
                    disabled={!editName.trim()}
                    ariaLabel="Save team details"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setIsEditing(false);
                      setEditName(currentTeam.name);
                      setEditDescription(currentTeam.description || "");
                      setError(null);
                    }}
                    disabled={loading}
                  >
                    <X className="h-4 w-4 mr-1" />
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Name</span>
                    <span className="text-sm font-medium">{currentTeam.name}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Description</span>
                    <span className="text-sm">{currentTeam.description || "—"}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Created by</span>
                    <span className="text-sm">{createdByLabel}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Members</span>
                    <span className="text-sm">{memberCount}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Created</span>
                    <span className="text-sm">
                      {new Date(currentTeam.created_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>

                {canManageTeam && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setIsEditing(true)}
                    className="gap-1"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </Button>
                )}
              </>
            )}
          </div>
        )}

        {/* Members Mode */}
        {activeMode === "members" && (
          <div className="space-y-4 py-2 flex-1 min-h-0 flex flex-col">
            {/* Add Member Form — Keycloak typeahead. The dropdown is purely
                a discovery aid: pressing Enter or clicking Add still POSTs
                the literal text in the input as `user_id`, so admins can
                provision a not-yet-Keycloak user by typing their full
                email. */}
            {canManageTeam && (
              <form
                onSubmit={handleAddMember}
                className="flex gap-2 relative"
                autoComplete="off"
              >
                <div className="flex-1 relative">
                <Search className="h-3.5 w-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <Input
                  placeholder="Search by name or email..."
                  value={newMemberEmail}
                  onChange={(e) => {
                    setNewMemberEmail(e.target.value);
                    setMemberSearchOpen(true);
                  }}
                  onFocus={() => setMemberSearchOpen(true)}
                  onBlur={() => {
                    // Delay so onMouseDown on a result still fires.
                    setTimeout(() => setMemberSearchOpen(false), 120);
                  }}
                  disabled={addingMember}
                  className="pl-8"
                  // We intentionally do NOT use type="email" — admins can
                  // search by name/username and pick the row, which then
                  // fills in the email.
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-form-type="other"
                />
                {memberSearchOpen && newMemberEmail.trim().length >= 2 && (
                  <div
                    className="absolute left-0 right-0 top-full mt-1 z-50 rounded-md border bg-popover shadow-md max-h-64 overflow-auto"
                    role="listbox"
                    aria-label="Matching users"
                  >
                    {memberSearchLoading && memberSearchResults.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Searching users…
                      </div>
                    ) : memberSearchResults.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        No matching users in Keycloak. Press Enter to add
                        <span className="font-mono"> {newMemberEmail.trim()}</span> directly.
                      </div>
                    ) : (
                      memberSearchResults.map((u) => {
                        const fullName = [u.firstName, u.lastName]
                          .filter(Boolean)
                          .join(" ")
                          .trim();
                        // Best-effort hint only: the member list is paginated,
                        // so we can confidently flag matches on the loaded page
                        // but cannot prove non-membership client-side. The add
                        // endpoint is authoritative and rejects true duplicates
                        // with a 400.
                        const alreadyMember = memberPage.some(
                          (m) => (m.user_email ?? "").toLowerCase() === u.email.toLowerCase()
                        );
                        return (
                          <button
                            key={u.id}
                            type="button"
                            role="option"
                            aria-selected={false}
                            disabled={alreadyMember}
                            // onMouseDown rather than onClick so the
                            // selection fires before the input's onBlur
                            // closes the popup.
                            onMouseDown={(e) => {
                              e.preventDefault();
                              if (alreadyMember) return;
                              handlePickMemberFromSearch(u);
                            }}
                            className="w-full text-left px-3 py-2 hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 border-b last:border-b-0"
                          >
                            <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-medium shrink-0">
                              {(fullName || u.email).charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="text-sm truncate">
                                {fullName || u.username || u.email}
                              </div>
                              <div className="text-xs text-muted-foreground truncate">
                                {u.email}
                              </div>
                            </div>
                            {alreadyMember && (
                              <Badge
                                variant="secondary"
                                className="text-[10px] shrink-0"
                              >
                                Already a member
                              </Badge>
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
                </div>
                <Select
                  value={newMemberRole}
                  onChange={(e) => setNewMemberRole(e.target.value as "member" | "admin")}
                  disabled={addingMember}
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </Select>
                <Button
                  type="submit"
                  size="sm"
                  disabled={addingMember || !newMemberEmail.trim()}
                  className="gap-1 h-9"
                >
                  {addingMember ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <UserPlus className="h-4 w-4" />
                  )}
                  Add
                </Button>
              </form>
            )}

            {/* Filter the roster by email. Debounced into a server-side
                query so it works regardless of how large the team is. */}
            <div className="relative">
              <Search className="h-3.5 w-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <Input
                placeholder="Filter members by email…"
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                className="pl-8 h-9"
                type="search"
                aria-label="Filter members by email"
              />
            </div>

            {/* Members List */}
            <ScrollArea className="[&>[data-radix-scroll-area-viewport]]:max-h-[320px] -mx-1 px-1">
              <div className="space-y-1">
                {membersLoading && memberPage.length === 0 ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : memberPage.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    {memberSearch.trim()
                      ? `No members match "${memberSearch.trim()}".`
                      : canManageTeam
                        ? "No members yet. Add members above."
                        : "No members."}
                  </p>
                ) : (
                  memberPage.map((member) => {
                    const email = member.user_email ?? member.identity_key;
                    const syncBadge = member.sync_status
                      ? syncBadgeAppearance(member.sync_status)
                      : null;
                    const isPendingRemove = pendingRemoveMember === email;
                    return (
                      <div
                        key={member.identity_key}
                        className={`flex items-center justify-between py-2 px-3 rounded-md group ${
                          isPendingRemove
                            ? "bg-destructive/5 ring-1 ring-destructive/20"
                            : "hover:bg-muted/50"
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-medium text-sm shrink-0">
                            {email.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm truncate">{email}</p>
                            {member.added_at && (
                              <p className="text-xs text-muted-foreground">
                                Added {new Date(member.added_at).toLocaleDateString()}
                              </p>
                            )}
                            {(member.source_types.length > 0 || syncBadge) && (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {member.source_types.map((sourceType) => (
                                  <Badge
                                    key={sourceType}
                                    variant={getSourceBadgeVariant(sourceType)}
                                    className="text-[10px] capitalize"
                                  >
                                    {getSourceLabel(sourceType)}
                                  </Badge>
                                ))}
                                {syncBadge && (
                                  <Badge
                                    variant={syncBadge.variant}
                                    className="text-[10px] gap-1"
                                    title={member.sync_reason ?? ""}
                                  >
                                    {syncBadge.icon}
                                    {syncBadge.label}
                                  </Badge>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge variant={getRoleBadgeVariant(member.role)} className="gap-1 text-xs">
                            {getRoleIcon(member.role)}
                            {member.role}
                          </Badge>
                          {canManageTeam && member.role !== "owner" && (
                            member.idp_managed ? (
                              <span
                                title="Managed by identity sync — edit membership in your IDP"
                                className="flex h-7 w-7 items-center justify-center text-muted-foreground/50"
                                aria-label="Managed by identity sync"
                              >
                                <Lock className="h-3.5 w-3.5" />
                              </span>
                            ) : (
                              pendingRemoveMember === email &&
                              removingMember !== email ? (
                                // Inline confirm row — replaces the previous
                                // window.confirm() blocking prompt. Stays on
                                // the same row so focus, scroll position, and
                                // the parent modal are all preserved.
                                <div
                                  className="flex items-center gap-1"
                                  role="group"
                                  aria-label={`Confirm removal of ${email}`}
                                  onKeyDown={(e) => {
                                    if (e.key === "Escape") {
                                      e.stopPropagation();
                                      setPendingRemoveMember(null);
                                    }
                                  }}
                                >
                                  <span
                                    className="text-xs text-muted-foreground mr-1"
                                    aria-live="polite"
                                  >
                                    Remove?
                                  </span>
                                  <Button
                                    variant="destructive"
                                    size="sm"
                                    className="h-7 px-2 text-xs"
                                    onClick={() => handleRemoveMember(email)}
                                    autoFocus
                                    aria-label={`Confirm remove ${email}`}
                                  >
                                    <Check className="h-3.5 w-3.5 mr-1" />
                                    Remove
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-0 text-muted-foreground"
                                    onClick={() => setPendingRemoveMember(null)}
                                    aria-label="Cancel removal"
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className={`h-7 w-7 p-0 text-muted-foreground hover:text-destructive ${
                                    removingMember === email
                                      ? "opacity-100"
                                      : "opacity-0 group-hover:opacity-100"
                                  }`}
                                  onClick={() => setPendingRemoveMember(email)}
                                  disabled={removingMember === email}
                                  aria-label={`Remove ${email}`}
                                >
                                  {removingMember === email ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Trash2 className="h-3.5 w-3.5" />
                                  )}
                                </Button>
                              )
                            )
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </ScrollArea>

            {/* Member pager — shown when the roster spans more than one page. */}
            {memberTotal > TEAM_MEMBERS_PAGE_SIZE && (
              <div className="flex items-center justify-between pt-1 text-xs">
                <span className="text-muted-foreground">
                  Page {memberPageNum} of {memberTotalPages} · {memberTotal} member
                  {memberTotal === 1 ? "" : "s"}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7"
                    onClick={() => goToMembersPage(memberPageNum - 1)}
                    disabled={memberPageNum <= 1 || membersLoading}
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7"
                    onClick={() => goToMembersPage(memberPageNum + 1)}
                    disabled={!memberHasMore || membersLoading}
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Agents access (Spec 104 — team-scoped RBAC). Agents and MCP are
            separate tabs but share one resources payload + save handler, so
            switching tabs preserves unsaved edits on either side and a single
            Save persists both. */}
        {activeMode === "resources" && (
          <div className="space-y-4 py-2 flex-1 min-h-0 flex flex-col">
            <p className="text-xs text-muted-foreground">
              Grant this team access to <span className="font-medium text-foreground">dynamic agents</span>{" "}
              — who can chat with (Use) or manage each agent. Changes apply to every member of this team.
            </p>

            {resourcesNotice && (
              <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-3">
                <p className="text-sm text-emerald-700 dark:text-emerald-400">
                  {resourcesNotice}
                </p>
              </div>
            )}

            {resourcesLoading || !resourcesData ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="flex-1 min-h-0">
                <AgentList
                  options={resourcesData.available.agents}
                  selectedUsers={selectedAgents}
                  selectedAdmins={selectedAgentAdmins}
                  onToggleUser={toggleAgent}
                  onToggleAdmin={toggleAgentAdmin}
                  readOnly={!canManageTeam}
                />
              </div>
            )}

            {canManageTeam && (
              <div className="flex justify-end gap-2 pt-2 border-t">
                <SaveButton
                  onSave={handleSaveResources}
                  saving={resourcesSaving}
                  dirty
                  hideDirtyBadge
                  disabled={resourcesLoading || !resourcesData}
                  ariaLabel="Save agent access"
                />
              </div>
            )}
          </div>
        )}

        {/* MCP servers access (Spec 104 — team-scoped RBAC). Shares the
            resources payload + save handler with the Agents tab above. */}
        {activeMode === "mcp" && (
          <div className="space-y-4 py-2 flex-1 min-h-0 flex flex-col">
            <p className="text-xs text-muted-foreground">
              Grant this team access to <span className="font-medium text-foreground">MCP servers</span>{" "}
              — which tool integrations appear in Dynamic Agents and skills. Changes apply to every member of this team.
            </p>

            {resourcesNotice && (
              <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-3">
                <p className="text-sm text-emerald-700 dark:text-emerald-400">
                  {resourcesNotice}
                </p>
              </div>
            )}

            {resourcesLoading || !resourcesData ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="flex-1 min-h-0">
                <ToolList
                  options={resourcesData.available.tools}
                  selected={selectedTools}
                  onToggle={toggleTool}
                  wildcard={toolWildcard}
                  onWildcardChange={setToolWildcard}
                  readOnly={!canManageTeam}
                />
              </div>
            )}

            {canManageTeam && (
              <div className="flex justify-end gap-2 pt-2 border-t">
                <SaveButton
                  onSave={handleSaveResources}
                  saving={resourcesSaving}
                  dirty
                  hideDirtyBadge
                  disabled={resourcesLoading || !resourcesData}
                  ariaLabel="Save MCP access"
                />
              </div>
            )}
          </div>
        )}

        {/* Read-only Skills tab. Skill team grants are written by the skill
            editor (skill-team-grants.ts), so this view only reflects them. */}
        {activeMode === "skills" && (
          <ReadOnlyResourceList
            loading={resourcesLoading || !resourcesData}
            items={resourcesData?.resources.skills ?? []}
            emptyLabel="No skills are shared with this team yet."
            description="Skills shared with this team (owned + shared). Manage sharing from the skill editor."
          />
        )}

        {/* Read-only Workflows tab. Workflow team grants are written by the
            workflow editor (workflow-config-rebac.ts). */}
        {activeMode === "workflows" && (
          <ReadOnlyResourceList
            loading={resourcesLoading || !resourcesData}
            items={resourcesData?.resources.workflows ?? []}
            emptyLabel="No workflows are shared with this team yet."
            description="Workflows shared with this team (owned + shared). Manage sharing from the workflow editor."
          />
        )}

        {/* Slack Channels Mode (Spec 098 US9 — channel ↔ team binding) */}
        {activeMode === "channels" && (
          <div className="space-y-4 py-2 flex-1 min-h-0 flex flex-col">
            <p className="text-xs text-muted-foreground">
              Slack channels bound to this team. Requests made in these channels
              use this team&apos;s access. To assign more channels, go to
              Integrations &rarr; Slack.
            </p>

            {channelsNotice && (
              <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-3">
                <p className="text-sm text-emerald-700 dark:text-emerald-400">
                  {channelsNotice}
                </p>
              </div>
            )}

            {channelsLoading || !channelsData ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <SlackChannelsPanel
                assigned={editedChannels}
                onRemove={handleRemoveChannel}
                readOnly={!canManageTeam}
              />
            )}

            {canManageTeam && (
              <div className="flex justify-end gap-2 pt-2 border-t">
                <SaveButton
                  onSave={handleSaveChannels}
                  saving={channelsSaving}
                  dirty
                  hideDirtyBadge
                  disabled={channelsLoading || !channelsData}
                  ariaLabel="Save channels"
                />
              </div>
            )}
          </div>
        )}

        {activeMode === "webex" && (
          <div className="space-y-4 py-2 flex-1 min-h-0 flex flex-col">
            <p className="text-xs text-muted-foreground">
              Webex spaces bound to this team. Requests made in these spaces use
              this team&apos;s access. To assign more spaces, go to Integrations
              &rarr; Webex.
            </p>

            {webexSpacesNotice && (
              <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-3">
                <p className="text-sm text-emerald-700 dark:text-emerald-400">
                  {webexSpacesNotice}
                </p>
              </div>
            )}

            {webexSpacesLoading || !webexSpacesData ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <WebexSpacesPanel
                assigned={editedWebexSpaces}
                onRemove={handleRemoveWebexSpace}
                readOnly={!canManageTeam}
              />
            )}

            {canManageTeam && (
              <div className="flex justify-end gap-2 pt-2 border-t">
                <SaveButton
                  onSave={handleSaveWebexSpaces}
                  saving={webexSpacesSaving}
                  dirty
                  hideDirtyBadge
                  disabled={webexSpacesLoading || !webexSpacesData}
                  ariaLabel="Save spaces"
                />
              </div>
            )}
          </div>
        )}

        {/* Knowledge Bases Mode (Spec 102/103 — RAG team-scoped access) */}
        {activeMode === "kbs" && (
          <div className="py-2 flex-1 min-h-0 overflow-y-auto space-y-4">
            {/* Explicit "data source author" capability (spec 2026-06-03) —
                gates whether members may create brand-new data sources, kept
                separate from the per-KB assignment below. */}
            <IngestCapabilityToggle
              teamId={currentTeam._id}
              teamName={currentTeam.name}
              readOnly={!canManageOrganization}
            />

            {/* Explicit "search" capability (spec
                2026-06-03-explicit-search-capability) — gates whether members
                may use Search (query + invoke search tools), separate from
                per-tool sharing and per-KB read grants below. */}
            <SearchCapabilityToggle
              teamId={currentTeam._id}
              teamName={currentTeam.name}
              readOnly={!canManageOrganization}
            />

            <TeamKbAssignmentPanel
              teamId={currentTeam._id}
              teamName={currentTeam.name}
              isAdmin={canManageTeam}
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Spec 104 — Agents picker. Each row has two independent checkboxes:
 * "Use" (base `user agent:<id>`) and "Manage" (base `manager agent:<id>`).
 * Manage implies Use in our authz model, so ticking Manage auto-ticks Use; the
 * UI mirrors this so admins don't end up with the visually-confusing
 * state of "manage but cannot use".
 */
/**
 * Read-only list of resource grants (skills, workflows). These resource types
 * have their own single writer (the skill / workflow editor), so the team
 * dialog only surfaces them for visibility — there are no edit affordances.
 */
function ReadOnlyResourceList({
  loading,
  items,
  emptyLabel,
  description,
}: {
  loading: boolean;
  items: NamedResource[];
  emptyLabel: string;
  description: string;
}) {
  return (
    <div className="space-y-4 py-2 flex-1 min-h-0 flex flex-col">
      <p className="text-xs text-muted-foreground">{description}</p>
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">{emptyLabel}</p>
      ) : (
        <ScrollArea className="[&>[data-radix-scroll-area-viewport]]:max-h-[320px] rounded-md border p-2">
          <ul className="space-y-1">
            {items.map((item) => (
              <li
                key={item.id}
                className="rounded-md px-3 py-2 hover:bg-muted/40"
              >
                <p className="text-sm font-medium">{item.name}</p>
                {item.description ? (
                  <p className="text-xs text-muted-foreground">{item.description}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}

function AgentList({
  options,
  selectedUsers,
  selectedAdmins,
  onToggleUser,
  onToggleAdmin,
  readOnly,
}: {
  options: ResourceOption[];
  selectedUsers: Set<string>;
  selectedAdmins: Set<string>;
  onToggleUser: (id: string) => void;
  onToggleAdmin: (id: string) => void;
  readOnly: boolean;
}) {
  const handleAdminClick = (id: string, currentlyAdmin: boolean) => {
    onToggleAdmin(id);
    // When promoting to admin, auto-grant Use as well (admin implies use).
    // When demoting, leave Use alone — the admin may want the user to keep
    // chat access without manage rights.
    if (!currentlyAdmin && !selectedUsers.has(id)) {
      onToggleUser(id);
    }
  };

  return (
    <div className="rounded-md border flex flex-col min-h-0">
      <div className="px-3 py-2 border-b bg-muted/30 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Dynamic agents ({selectedUsers.size} / {options.length})
          </p>
          <p className="text-[10px] text-muted-foreground normal-case tracking-normal">
            Chat access (Use) and editor access (Manage)
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[10px] uppercase tracking-wide text-muted-foreground">
          <span>Use</span>
          <span>Manage</span>
        </div>
      </div>
      <ScrollArea className="[&>[data-radix-scroll-area-viewport]]:max-h-[260px] p-2">
        {options.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No agents available
          </p>
        ) : (
          <ul className="space-y-1">
            {options.map((opt) => {
              const isUser = selectedUsers.has(opt.id);
              const isAdmin = selectedAdmins.has(opt.id);
              return (
                <li
                  key={opt.id}
                  className="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-muted/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-mono truncate">{opt.name}</span>
                    {opt.description ? (
                      <span className="block text-xs text-muted-foreground truncate">
                        {opt.description}
                      </span>
                    ) : null}
                  </span>
                  <div className="flex items-center gap-3 mt-0.5">
                    <label
                      className="flex items-center cursor-pointer"
                      title="Can use this agent. Team members can chat with it."
                    >
                      <input
                        type="checkbox"
                        checked={isUser}
                        onChange={() => onToggleUser(opt.id)}
                        // Disabling Use when Manage is on prevents the
                        // user from accidentally creating an "admin but no
                        // use" state that authz actually allows but is
                        // confusing. They can untick Manage first.
                        disabled={readOnly || isAdmin}
                      />
                    </label>
                    <label
                      className="flex items-center cursor-pointer"
                      title="Can manage this agent. Team admins can edit and configure it."
                    >
                      <input
                        type="checkbox"
                        checked={isAdmin}
                        onChange={() => handleAdminClick(opt.id, isAdmin)}
                        disabled={readOnly}
                      />
                    </label>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

/**
 * Spec 104 — Tools picker. A single column of MCP-server prefixes plus a
 * single "All tools" wildcard checkbox at the top. Wildcard does not visually
 * un-tick the per-server boxes — they stay as a record of intent — and the
 * backend expands wildcard intent into concrete per-server OpenFGA tuples.
 */
function ToolList({
  options,
  selected,
  onToggle,
  wildcard,
  onWildcardChange,
  readOnly,
}: {
  options: ResourceOption[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  wildcard: boolean;
  onWildcardChange: (v: boolean) => void;
  readOnly: boolean;
}) {
  return (
    <div className="rounded-md border flex flex-col min-h-0">
      <div className="px-3 py-2 border-b bg-muted/30">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          MCP servers ({selected.size} / {options.length})
          {wildcard && (
            <Badge variant="secondary" className="ml-2 text-[10px]">
              wildcard
            </Badge>
          )}
        </p>
        <p className="text-[10px] text-muted-foreground normal-case tracking-normal mt-0.5">
          Which MCP integrations team members can use in Dynamic Agents and skills
        </p>
      </div>
      <div className="px-3 py-2 border-b bg-amber-500/5">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={wildcard}
            onChange={(e) => onWildcardChange(e.target.checked)}
            disabled={readOnly}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">All MCP servers (wildcard)</span>
            <span className="block text-xs text-muted-foreground">
              Grant this team permission to use any MCP server. Use sparingly.
            </span>
          </span>
        </label>
      </div>
      <ScrollArea className="[&>[data-radix-scroll-area-viewport]]:max-h-[200px] p-2">
        {options.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No MCP servers available
          </p>
        ) : (
          <ul className="space-y-1">
            {options.map((opt) => {
              const checked = selected.has(opt.id);
              return (
                <li key={opt.id}>
                  <label
                    className={`flex items-start gap-2 px-2 py-1.5 rounded hover:bg-muted/50 cursor-pointer ${
                      wildcard ? "opacity-60" : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={checked}
                      onChange={() => onToggle(opt.id)}
                      disabled={readOnly}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-mono truncate">{opt.name}</span>
                      {opt.description ? (
                        <span className="block text-xs text-muted-foreground truncate">
                          {opt.description}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

/**
 * Spec 098 US9 — Slack channels list (read + unassign).
 *
 * Shows only the channels currently assigned to this team. Channel discovery
 * and assignment live under Integrations → Slack; here an admin can review
 * what's bound and remove a channel, then Save to apply.
 */
function SlackChannelsPanel({
  assigned,
  onRemove,
  readOnly,
}: {
  assigned: TeamSlackChannel[];
  onRemove: (id: string) => void;
  readOnly: boolean;
}) {
  return (
    <div className="rounded-md border flex flex-col min-h-0 flex-1">
      <div className="px-3 py-2 border-b bg-muted/30">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Assigned channels ({assigned.length})
        </p>
      </div>
      <ScrollArea className="[&>[data-radix-scroll-area-viewport]]:max-h-[320px] p-2">
        {assigned.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No channels assigned. Assign channels under Integrations &rarr; Slack.
          </p>
        ) : (
          <ul className="space-y-2">
            {assigned.map((c) => (
              <li
                key={c.slack_channel_id}
                className="rounded border p-2 space-y-2 bg-background"
              >
                <div className="flex items-start gap-2">
                  <Hash className="h-3.5 w-3.5 mt-1 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">
                      {c.channel_name}
                    </div>
                    <div className="text-[11px] font-mono text-muted-foreground truncate">
                      {c.slack_channel_id}
                    </div>
                  </div>
                  {!readOnly && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => onRemove(c.slack_channel_id)}
                      title="Remove from team"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

/**
 * Webex spaces list (read + unassign). Mirrors {@link SlackChannelsPanel}:
 * shows only the team's currently-assigned spaces. Space discovery and
 * assignment live under Integrations &rarr; Webex.
 */
function WebexSpacesPanel({
  assigned,
  onRemove,
  readOnly,
}: {
  assigned: TeamWebexSpace[];
  onRemove: (id: string) => void;
  readOnly: boolean;
}) {
  return (
    <div className="rounded-md border flex flex-col min-h-0 flex-1">
      <div className="px-3 py-2 border-b bg-muted/30">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Assigned spaces ({assigned.length})
        </p>
      </div>
      <ScrollArea className="[&>[data-radix-scroll-area-viewport]]:max-h-[320px] p-2">
        {assigned.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No spaces assigned. Assign spaces under Integrations &rarr; Webex.
          </p>
        ) : (
          <ul className="space-y-2">
            {assigned.map((space) => (
              <li
                key={space.webex_space_id}
                className="rounded border p-2 space-y-2 bg-background"
              >
                <div className="flex items-start gap-2">
                  <MessageSquare className="h-3.5 w-3.5 mt-1 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{space.space_name}</div>
                    <div className="text-[11px] font-mono text-muted-foreground truncate">
                      {space.webex_space_id}
                    </div>
                  </div>
                  {!readOnly && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => onRemove(space.webex_space_id)}
                      title="Remove from team"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}
