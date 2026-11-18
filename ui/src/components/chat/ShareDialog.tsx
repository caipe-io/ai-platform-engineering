"use client";

import { Select } from "@/components/ui/select";
import { getErrorMessage } from "@/lib/error-utils";

import { apiClient } from "@/lib/api-client";
import { useChatStore } from "@/store/chat-store";
import type { UserPublicInfo } from "@/types/mongodb";
import type { Team } from "@/types/teams";
import { Check,Copy,Loader2,Mail,Trash2,Users,X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback,useEffect,useRef,useState } from "react";
import { createPortal } from "react-dom";

type SharePermission = 'view' | 'comment';
const TEAM_SHARE_SEARCH_ENDPOINT = '/api/dynamic-agents/teams';

type SharingSnapshot = {
  is_public?: boolean;
  shared_with?: string[];
  shared_with_teams?: string[];
  team_permissions?: Record<string, SharePermission>;
  share_link_enabled?: boolean;
};

interface ShareDialogProps {
  conversationId: string;
  conversationTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canManageSharing?: boolean;
  sharedBy?: string;
  initialSharing?: SharingSnapshot;
}

function teamShareRef(team: Team): string {
  return team.slug?.trim() || String(team._id);
}

function teamAliases(team: Team): string[] {
  return Array.from(new Set([team.slug, team._id].map((value) => String(value || '').trim()).filter(Boolean)));
}

function isTeamAlreadyShared(team: Team, sharedTeamRefs: string[]): boolean {
  const sharedRefs = new Set(sharedTeamRefs.map((value) => String(value).trim()).filter(Boolean));
  return teamAliases(team).some((alias) => sharedRefs.has(alias));
}

async function fetchShareableTeams(options: {
  query?: string;
  refs?: string[];
  signal?: AbortSignal;
} = {}): Promise<Team[]> {
  const searchParams = new URLSearchParams();
  if (options.query) {
    searchParams.set('q', options.query);
    searchParams.set('limit', '20');
  }
  for (const ref of options.refs || []) searchParams.append('ref', ref);
  if (!options.query && options.refs?.length) {
    searchParams.set('limit', String(Math.min(options.refs.length, 50)));
  }
  const queryString = searchParams.toString();
  const teamsResponse = await fetch(
    `${TEAM_SHARE_SEARCH_ENDPOINT}${queryString ? `?${queryString}` : ''}`,
    { signal: options.signal },
  );
  if (!teamsResponse.ok) return [];
  const teamsData = await teamsResponse.json();
  if (Array.isArray(teamsData.data)) return teamsData.data;
  return teamsData.data?.teams || [];
}

export function ShareDialog({
  conversationId,
  conversationTitle,
  open,
  onOpenChange,
  canManageSharing = true,
  sharedBy,
  initialSharing,
}: ShareDialogProps) {
  const router = useRouter();
  const updateConversationSharing = useChatStore((state) => state.updateConversationSharing);
  const [searchInput, setSearchInput] = useState("");
  const [userResults, setUserResults] = useState<UserPublicInfo[]>([]);
  const [teamResults, setTeamResults] = useState<Team[]>([]);
  const [searching, setSearching] = useState(false);
  const [sharedWith, setSharedWith] = useState<string[]>([]);
  const [sharedWithTeams, setSharedWithTeams] = useState<string[]>([]);
  const [teamNames, setTeamNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [noResults, setNoResults] = useState(false);
  const [isLegacyConversation, setIsLegacyConversation] = useState(false);
  const [userPermissions, setUserPermissions] = useState<Record<string, SharePermission>>({});
  const [teamPermissions, setTeamPermissions] = useState<Record<string, SharePermission>>({});
  const [defaultPermission, setDefaultPermission] = useState<SharePermission>('comment');
  const [pendingAccessAction, setPendingAccessAction] = useState<string | null>(null);
  const [sharingInfoLoading, setSharingInfoLoading] = useState(false);
  const sharingLoadGenerationRef = useRef(0);
  const sharingMutationGenerationRef = useRef(0);
  const activeDialogRef = useRef({ conversationId, open });
  if (activeDialogRef.current.conversationId !== conversationId || activeDialogRef.current.open !== open) {
    activeDialogRef.current = { conversationId, open };
  }
  const initialSharingRef = useRef(initialSharing);
  const permissionsConversationIdRef = useRef(conversationId);
  const shareableTeamsRef = useRef<Team[] | null>(null);
  const shareableTeamsRequestRef = useRef<Promise<Team[]> | null>(null);

  const shareUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/chat/${conversationId}`;
  const sharedByLabel = sharedBy?.trim();

  const applySharingSnapshot = useCallback((sharing?: SharingSnapshot) => {
    setSharedWith(sharing?.shared_with || []);
    const teamIds = sharing?.shared_with_teams || [];
    setSharedWithTeams(teamIds);
    setTeamPermissions(sharing?.team_permissions || {});
  }, []);

  const getShareableTeams = useCallback(async (): Promise<Team[]> => {
    if (shareableTeamsRef.current) return shareableTeamsRef.current;
    if (shareableTeamsRequestRef.current) return shareableTeamsRequestRef.current;

    const request = fetchShareableTeams()
      .then((teams) => {
        shareableTeamsRef.current = teams;
        return teams;
      })
      .finally(() => {
        shareableTeamsRequestRef.current = null;
      });
    shareableTeamsRequestRef.current = request;
    return request;
  }, []);

  const invalidateSharingLoad = useCallback(() => {
    sharingLoadGenerationRef.current += 1;
    setSharingInfoLoading(false);
  }, []);

  const beginSharingMutation = () => {
    invalidateSharingLoad();
    const dialog = activeDialogRef.current;
    const generation = ++sharingMutationGenerationRef.current;
    return () => activeDialogRef.current === dialog && dialog.open
      && sharingMutationGenerationRef.current === generation;
  };

  const loadSharingInfo = useCallback(async () => {
    const generation = ++sharingLoadGenerationRef.current;
    const isCurrent = () => sharingLoadGenerationRef.current === generation
      && activeDialogRef.current.conversationId === conversationId && activeDialogRef.current.open;
    setSharingInfoLoading(true);
    try {
      const response = await fetch(`/api/chat/conversations/${conversationId}/share`);
      if (!isCurrent()) return;
      if (response.ok) {
        const data = await response.json();
        if (!isCurrent()) return;
        const sharing = data.data?.sharing;
        setSharedWith(sharing?.shared_with || []);
        const teamIds = sharing?.shared_with_teams || [];
        setSharedWithTeams(teamIds);
        setIsLegacyConversation(false);

        // Build per-user permission map from access_list
        const accessList = data.data?.access_list || [];
        const userPerms: Record<string, SharePermission> = {};
        for (const entry of accessList) {
          if (entry.granted_to && entry.permission) {
            userPerms[entry.granted_to] = entry.permission;
          }
        }
        setUserPermissions(userPerms);

        // Build per-team permission map from sharing.team_permissions
        setTeamPermissions(sharing?.team_permissions || {});

        // Keep the sidebar snapshot current. initialSharing is intentionally
        // not a load-effect dependency, so this store update cannot refetch.
        if (sharing) {
          updateConversationSharing(conversationId, {
            is_public: false,
            shared_with: sharing.shared_with,
            shared_with_teams: sharing.shared_with_teams,
            team_permissions: sharing.team_permissions,
            share_link_enabled: sharing.share_link_enabled,
          });
        }

        // Load team names for display
        if (teamIds.length > 0) {
          try {
            const allTeams = await getShareableTeams();
            if (!isCurrent()) return;
            const namesMap: Record<string, string> = {};
            allTeams.forEach((team: Team) => {
              for (const alias of teamAliases(team)) {
                if (teamIds.includes(alias)) {
                  namesMap[alias] = team.name;
                }
              }
            });
            setTeamNames(namesMap);
          } catch (err) {
            console.error("Failed to load team names:", err);
          }
        }
      } else if (response.status === 404) {
        // Conversation not found — may still be syncing to MongoDB.
        // Only treat as legacy if storageMode is localStorage (no MongoDB at all).
        const { getStorageMode } = await import('@/lib/storage-config');
        if (!isCurrent()) return;
        const mode = getStorageMode();
        if (mode === 'mongodb') {
          // MongoDB is enabled but the conversation hasn't been persisted yet.
          // Show a transient "not ready" state instead of the legacy message.
          console.warn('[ShareDialog] Conversation not yet in MongoDB — may still be syncing:', conversationId);
          setIsLegacyConversation(false);
        } else {
          setIsLegacyConversation(true);
        }
      }
    } catch (err) {
      if (!isCurrent()) return;
      console.error("Failed to load sharing info:", err);
      // Don't assume legacy on network errors — only on explicit 404 + localStorage mode
      setIsLegacyConversation(false);
    } finally {
      if (isCurrent()) setSharingInfoLoading(false);
    }
  }, [conversationId, getShareableTeams, updateConversationSharing]);

  useEffect(() => {
    initialSharingRef.current = initialSharing;
  }, [initialSharing]);

  // Load current sharing info once when the dialog opens or the conversation changes.
  useEffect(() => {
    setLoading(false);
    setPendingAccessAction(null);
    if (!open) {
      setSharingInfoLoading(false);
      return;
    }

    if (permissionsConversationIdRef.current !== conversationId) {
      permissionsConversationIdRef.current = conversationId;
      setUserPermissions({});
      setTeamPermissions({});
    }

    applySharingSnapshot(initialSharingRef.current);
    void loadSharingInfo();
    if (canManageSharing) {
      void getShareableTeams().catch((err) => {
        console.error("Failed to load shareable teams:", err);
      });
    }

    return () => {
      sharingLoadGenerationRef.current += 1;
    };
  }, [open, conversationId, canManageSharing, applySharingSnapshot, getShareableTeams, loadSharingInfo]);

  const sharedWithSearchKey = sharedWith.join('\u0000');
  const sharedWithTeamsSearchKey = sharedWithTeams.join('\u0000');

  // Search users and teams as they type
  useEffect(() => {
    const query = searchInput.trim();
    if (!canManageSharing || query.length < 2) {
      setUserResults([]);
      setTeamResults([]);
      setNoResults(false);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setUserResults([]);
    setTeamResults([]);
    setNoResults(false);
    setSearching(true);

    const timer = setTimeout(() => {
      void (async () => {
        const [usersResult, teamsResult] = await Promise.allSettled([
          apiClient.searchUsers(query),
          getShareableTeams(),
        ]);
        if (cancelled) return;

        if (usersResult.status === 'rejected') {
          console.error("User search failed:", usersResult.reason);
        }
        if (teamsResult.status === 'rejected') {
          console.error("Team search failed:", teamsResult.reason);
        }

        const sharedUserEmails = new Set(sharedWithSearchKey.split('\u0000').filter(Boolean));
        const sharedTeamRefs = sharedWithTeamsSearchKey.split('\u0000').filter(Boolean);
        const users = usersResult.status === 'fulfilled' ? usersResult.value : [];
        const allTeams = teamsResult.status === 'fulfilled' ? teamsResult.value : [];
        const filteredUsers = users.filter((user) => !sharedUserEmails.has(user.email));
        const searchLower = query.toLowerCase();
        const matchingTeams = allTeams.filter((team: Team) => {
          const nameMatch = team.name.toLowerCase().includes(searchLower);
          const slugMatch = team.slug?.toLowerCase().includes(searchLower);
          const descMatch = team.description?.toLowerCase().includes(searchLower);
          return (nameMatch || slugMatch || descMatch) && !isTeamAlreadyShared(team, sharedTeamRefs);
        });

        setUserResults(filteredUsers);
        setTeamResults(matchingTeams);
        setNoResults(filteredUsers.length === 0 && matchingTeams.length === 0);
        setSearching(false);
      })();
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    searchInput,
    sharedWithSearchKey,
    sharedWithTeamsSearchKey,
    canManageSharing,
    getShareableTeams,
  ]);

  const handleShareUser = async (email: string) => {
    if (!canManageSharing) return;
    const isCurrent = beginSharingMutation();
    setLoading(true);
    try {
      const updatedConversation = await apiClient.shareConversation(conversationId, {
        user_emails: [email],
        permission: defaultPermission,
      });

      // Update store with new sharing info so Sidebar shows icon immediately
      if (updatedConversation?.sharing) {
        updateConversationSharing(conversationId, {
          is_public: false,
          shared_with: updatedConversation.sharing.shared_with,
          shared_with_teams: updatedConversation.sharing.shared_with_teams,
          team_permissions: updatedConversation.sharing.team_permissions,
          share_link_enabled: updatedConversation.sharing.share_link_enabled,
        });
      }

      if (!isCurrent()) return;
      setSharedWith([...sharedWith, email]);
      setUserPermissions({ ...userPermissions, [email]: defaultPermission });

      setSearchInput("");
      setUserResults([]);
      setTeamResults([]);
      setNoResults(false);
    } catch (err) {
      if (!isCurrent()) return;
      console.error("Failed to share:", err);
      const errorMessage = getErrorMessage(err, "") || "Failed to share conversation";

      if (errorMessage.includes("not found") || errorMessage.includes("404")) {
        alert("This conversation doesn't exist in the database. Please create a new conversation to use sharing features.");
        onOpenChange(false);
      } else {
        alert(`Failed to share: ${errorMessage}`);
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  };

  const handleShareTeam = async (teamId: string) => {
    if (!canManageSharing) return;
    const isCurrent = beginSharingMutation();
    setLoading(true);
    try {
      const updatedConversation = await apiClient.shareConversation(conversationId, {
        team_ids: [teamId],
        permission: defaultPermission,
      });

      // Update store with new sharing info so Sidebar shows icon immediately
      if (updatedConversation?.sharing) {
        updateConversationSharing(conversationId, {
          is_public: false,
          shared_with: updatedConversation.sharing.shared_with,
          shared_with_teams: updatedConversation.sharing.shared_with_teams,
          team_permissions: updatedConversation.sharing.team_permissions,
          share_link_enabled: updatedConversation.sharing.share_link_enabled,
        });
      }

      if (!isCurrent()) return;
      // Reload sharing info to get updated state (updates dialog UI)
      await loadSharingInfo();
      if (!isCurrent()) return;

      setSearchInput("");
      setUserResults([]);
      setTeamResults([]);
      setNoResults(false);
    } catch (err) {
      if (!isCurrent()) return;
      console.error("Failed to share with team:", err);
      alert(`Failed to share with team: ${getErrorMessage(err, "") || 'Unknown error'}`);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const handlePermissionChange = async (
    target: { email?: string; team_id?: string },
    newPermission: SharePermission
  ) => {
    if (!canManageSharing) return;
    const isCurrent = beginSharingMutation();
    const targetKey = target.email ? `user:${target.email}` : `team:${target.team_id}`;
    const previousPermission = target.email
      ? userPermissions[target.email] || 'view'
      : target.team_id
        ? teamPermissions[target.team_id] || 'view'
        : undefined;

    if (target.email) {
      setUserPermissions((prev) => ({ ...prev, [target.email!]: newPermission }));
    }
    if (target.team_id) {
      setTeamPermissions((prev) => ({ ...prev, [target.team_id!]: newPermission }));
    }
    setPendingAccessAction(`permission:${targetKey}`);
    try {
      const response = await fetch(`/api/chat/conversations/${conversationId}/share`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...target, permission: newPermission }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(errorData?.error || errorData?.message || response.statusText || 'Failed to update permission');
      }
      const responseData = await response.json();
      const updatedConversation = responseData.data;
      if (updatedConversation?.sharing) {
        updateConversationSharing(conversationId, {
          is_public: false,
          shared_with: updatedConversation.sharing.shared_with,
          shared_with_teams: updatedConversation.sharing.shared_with_teams,
          team_permissions: updatedConversation.sharing.team_permissions,
          share_link_enabled: updatedConversation.sharing.share_link_enabled,
        });
      }
    } catch (err) {
      if (!isCurrent()) return;
      if (target.email && previousPermission) {
        setUserPermissions((prev) => ({ ...prev, [target.email!]: previousPermission }));
      }
      if (target.team_id && previousPermission) {
        setTeamPermissions((prev) => ({ ...prev, [target.team_id!]: previousPermission }));
      }
      console.error('Failed to update permission:', err);
      alert(`Failed to update permission: ${getErrorMessage(err, "") || 'Unknown error'}`);
    } finally {
      if (isCurrent()) setPendingAccessAction(null);
    }
  };

  const handleRemoveAccess = async (target: { email?: string; team_id?: string }) => {
    if (!canManageSharing) return;
    const isCurrent = beginSharingMutation();
    const targetKey = target.email ? `user:${target.email}` : `team:${target.team_id}`;
    setPendingAccessAction(`remove:${targetKey}`);
    try {
      const updatedConversation = await apiClient.revokeConversationShare(conversationId, target);
      if (updatedConversation?.sharing) {
        updateConversationSharing(conversationId, {
          is_public: false,
          shared_with: updatedConversation.sharing.shared_with,
          shared_with_teams: updatedConversation.sharing.shared_with_teams,
          team_permissions: updatedConversation.sharing.team_permissions,
          share_link_enabled: updatedConversation.sharing.share_link_enabled,
        });
      }
      if (!isCurrent()) return;
      if (target.email) {
        setSharedWith((prev) => prev.filter((email) => email !== target.email));
        setUserPermissions((prev) => {
          const next = { ...prev };
          delete next[target.email!];
          return next;
        });
      }
      if (target.team_id) {
        setSharedWithTeams((prev) => prev.filter((teamId) => teamId !== target.team_id));
        setTeamPermissions((prev) => {
          const next = { ...prev };
          delete next[target.team_id!];
          return next;
        });
      }
    } catch (err) {
      if (!isCurrent()) return;
      console.error('Failed to remove access:', err);
      alert(`Failed to remove access: ${getErrorMessage(err, "") || 'Unknown error'}`);
    } finally {
      if (isCurrent()) setPendingAccessAction(null);
    }
  };

  if (!open || typeof document === 'undefined') return null;

  // Render modal as a portal at document body level
  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        // Close dialog when clicking backdrop
        if (e.target === e.currentTarget) {
          onOpenChange(false);
        }
      }}
    >
      <div
        className="bg-background rounded-lg shadow-xl w-full max-w-md p-6 mx-auto my-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        onClick={(e) => e.stopPropagation()} // Prevent closing when clicking inside dialog
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 id="share-dialog-title" className="text-lg font-semibold">
              {canManageSharing ? 'Share Conversation' : 'Shared Conversation'}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {conversationTitle}
            </p>
          </div>
          <button
            onClick={() => onOpenChange(false)}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Legacy conversation message */}
        {isLegacyConversation ? (
          <div className="py-8">
            <div className="flex flex-col items-center text-center gap-4">
              <div className="w-16 h-16 rounded-full bg-yellow-500/10 flex items-center justify-center">
                <Mail className="h-8 w-8 text-yellow-500" />
              </div>
              <div>
                <h3 className="font-semibold mb-2">Legacy Conversation</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  This conversation was created before MongoDB integration and cannot be shared.
                </p>
                <p className="text-sm text-muted-foreground">
                  Please create a new conversation to use sharing features.
                </p>
              </div>
              <button
                onClick={() => {
                  onOpenChange(false);
                  router.push("/chat");
                }}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
              >
                Create New Conversation
              </button>
            </div>
          </div>
        ) : (
          <>
            {!canManageSharing && sharedByLabel && (
              <div className="mb-4 rounded-md border bg-muted/40 px-3 py-2">
                <div className="text-xs text-muted-foreground">Shared by</div>
                <div className="text-sm font-medium truncate">{sharedByLabel}</div>
              </div>
            )}

            {/* Copy link section */}
        <div className="mb-6">
          <label className="text-sm font-medium mb-2 block">Share Link</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={shareUrl}
              readOnly
              className="flex-1 px-3 py-2 text-sm border rounded-md bg-muted"
            />
            <button
              onClick={handleCopyLink}
              className="px-3 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 flex items-center gap-2"
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  Copy
                </>
              )}
            </button>
          </div>
        </div>

        <p className="mb-4 text-xs text-muted-foreground">
          Chat sharing does not grant agent access. People with Can edit access also need
          access to the agent to send messages.
        </p>

        {/* Add people and teams section */}
        {canManageSharing && (
        <div className="mb-6">
          <label className="text-sm font-medium mb-2 block">
            People, Teams
          </label>
          <div className="relative flex gap-2">
            <input
              type="text"
              placeholder="Search by email or team name..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="flex-1 px-3 py-2 text-sm border rounded-md"
            />
            <Select
              value={defaultPermission}
              onChange={(e) => setDefaultPermission(e.target.value as SharePermission)}
              className="text-xs border rounded-md px-2 py-2 bg-background text-muted-foreground hover:text-foreground cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary/50"
              title="Permission for new shares"
            >
              <option value="view">Can view</option>
              <option value="comment">Can edit</option>
            </Select>

            {/* Search results dropdown */}
            {((userResults.length > 0 || teamResults.length > 0 || noResults) && searchInput.length >= 2) && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-background border rounded-md shadow-lg max-h-64 overflow-y-auto z-10">
                {/* User Results */}
                {userResults.length > 0 && (
                  <div className="px-2 py-1 border-b">
                    <div className="text-xs font-medium text-muted-foreground px-2 py-1">People</div>
                    {userResults.map((user) => (
                      <button
                        key={user.email}
                        onClick={() => handleShareUser(user.email)}
                        disabled={loading}
                        className="w-full px-3 py-2 text-left hover:bg-muted flex items-center gap-2 text-sm rounded-md"
                      >
                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-medium">
                          {user.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1">
                          <div className="font-medium">{user.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {user.email}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {/* Team Results */}
                {teamResults.length > 0 && (
                  <div className="px-2 py-1">
                    <div className="text-xs font-medium text-muted-foreground px-2 py-1">Teams</div>
                    {teamResults.map((team) => (
                      <button
                        key={teamShareRef(team)}
                        onClick={() => handleShareTeam(teamShareRef(team))}
                        disabled={loading}
                        className="w-full px-3 py-2 text-left hover:bg-muted flex items-center gap-2 text-sm rounded-md"
                      >
                        <div className="h-8 w-8 rounded-full bg-blue-500/10 flex items-center justify-center text-blue-600 dark:text-blue-400">
                          <Users className="h-4 w-4" />
                        </div>
                        <div className="flex-1">
                          <div className="font-medium">{team.name}</div>
                          {team.description && (
                            <div className="text-xs text-muted-foreground">
                              {team.description}
                            </div>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {/* Only provisioned Keycloak users are shareable. */}
                {noResults && !searching && userResults.length === 0 && teamResults.length === 0 && (
                  <div className="px-3 py-4">
                    <p className="text-sm text-muted-foreground">
                      No people or teams found
                    </p>
                  </div>
                )}
              </div>
            )}

            {searching && (
              <div className="absolute right-3 top-2.5">
                <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
              </div>
            )}
          </div>
        </div>
        )}

        {/* People and Teams with access */}
        {(sharedWith.length > 0 || sharedWithTeams.length > 0) && (
          <div>
            <label className="text-sm font-medium mb-2 block">
              Access ({`${sharedWith.length + sharedWithTeams.length} ${sharedWith.length + sharedWithTeams.length === 1 ? 'person/team' : 'people/teams'}`})
            </label>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {/* People */}
              {sharedWith.map((email) => {
                const targetKey = `user:${email}`;
                const permissionPending = pendingAccessAction === `permission:${targetKey}`;
                const removalPending = pendingAccessAction === `remove:${targetKey}`;
                const permissionUnknown = sharingInfoLoading && userPermissions[email] === undefined;
                return (
                <div
                  key={email}
                  className="flex items-center justify-between py-2 px-3 bg-muted rounded-md"
                >
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-medium text-sm shrink-0">
                      {email.charAt(0).toUpperCase()}
                    </div>
                    <div className="text-sm truncate">{email}</div>
                  </div>
                  {canManageSharing ? (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Select
                      value={permissionUnknown ? '' : userPermissions[email] || 'view'}
                      onChange={(e) => handlePermissionChange({ email }, e.target.value as SharePermission)}
                      disabled={loading || pendingAccessAction !== null || permissionUnknown}
                      aria-label={`Permission for ${email}`}
                      className="min-w-[5.5rem] text-xs bg-transparent border border-border rounded px-1.5 py-1 text-muted-foreground hover:text-foreground cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-100 disabled:text-muted-foreground"
                    >
                      {permissionUnknown && <option value="">Loading…</option>}
                      <option value="view">Can view</option>
                      <option value="comment">Can edit</option>
                    </Select>
                    <span
                      className="inline-flex h-4 w-4 shrink-0 items-center justify-center"
                      data-testid={`permission-status-${email}`}
                      role="status"
                      aria-label={permissionPending ? `Updating permission for ${email}` : undefined}
                    >
                      {permissionPending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    </span>
                    <button
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => void handleRemoveAccess({ email })}
                      disabled={loading || pendingAccessAction !== null}
                      aria-label={`Remove access for ${email}`}
                    >
                      {removalPending
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Trash2 className="h-4 w-4" />}
                    </button>
                  </div>
                  ) : (
                    <span className="text-xs text-muted-foreground shrink-0">
                      {(userPermissions[email] || 'view') === 'comment' ? 'Can edit' : 'Can view'}
                    </span>
                  )}
                </div>
                );
              })}
              {/* Teams */}
              {sharedWithTeams.map((teamId) => {
                const targetKey = `team:${teamId}`;
                const permissionPending = pendingAccessAction === `permission:${targetKey}`;
                const removalPending = pendingAccessAction === `remove:${targetKey}`;
                const permissionUnknown = sharingInfoLoading && teamPermissions[teamId] === undefined;
                return (
                <div
                  key={teamId}
                  className="flex items-center justify-between py-2 px-3 bg-muted rounded-md"
                >
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <div className="h-8 w-8 rounded-full bg-blue-500/10 flex items-center justify-center text-blue-600 dark:text-blue-400 shrink-0">
                      <Users className="h-4 w-4" />
                    </div>
                    <div className="text-sm truncate">
                      {teamNames[teamId] || `Team: ${teamId}`}
                    </div>
                  </div>
                  {canManageSharing ? (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Select
                      value={permissionUnknown ? '' : teamPermissions[teamId] || 'view'}
                      onChange={(e) => handlePermissionChange({ team_id: teamId }, e.target.value as SharePermission)}
                      disabled={loading || pendingAccessAction !== null || permissionUnknown}
                      aria-label={`Permission for ${teamNames[teamId] || teamId}`}
                      className="min-w-[5.5rem] text-xs bg-transparent border border-border rounded px-1.5 py-1 text-muted-foreground hover:text-foreground cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-100 disabled:text-muted-foreground"
                    >
                      {permissionUnknown && <option value="">Loading…</option>}
                      <option value="view">Can view</option>
                      <option value="comment">Can edit</option>
                    </Select>
                    <span
                      className="inline-flex h-4 w-4 shrink-0 items-center justify-center"
                      data-testid={`permission-status-${teamId}`}
                      role="status"
                      aria-label={permissionPending ? `Updating permission for ${teamNames[teamId] || teamId}` : undefined}
                    >
                      {permissionPending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    </span>
                    <button
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => void handleRemoveAccess({ team_id: teamId })}
                      disabled={loading || pendingAccessAction !== null}
                      aria-label={`Remove access for ${teamNames[teamId] || teamId}`}
                    >
                      {removalPending
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Trash2 className="h-4 w-4" />}
                    </button>
                  </div>
                  ) : (
                    <span className="text-xs text-muted-foreground shrink-0">
                      {(teamPermissions[teamId] || 'view') === 'comment' ? 'Can edit' : 'Can view'}
                    </span>
                  )}
                </div>
                );
              })}
            </div>
          </div>
        )}
          </>
        )}

        {/* Footer actions - only show for non-legacy conversations */}
        {!isLegacyConversation && (
          <div className="mt-6 flex justify-end gap-2">
            <button
              onClick={() => onOpenChange(false)}
              className="px-4 py-2 text-sm border rounded-md hover:bg-muted"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
