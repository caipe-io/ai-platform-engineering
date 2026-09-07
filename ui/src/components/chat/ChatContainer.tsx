"use client";

import { getErrorMessage } from "@/lib/error-utils";

import { ChatView } from "@/components/chat/DynamicAgentChatView";
import { CAIPESpinner } from "@/components/ui/caipe-spinner";
import { apiClient } from "@/lib/api-client";
import { getStorageMode } from "@/lib/storage-config";
import { useChatStore } from "@/store/chat-store";
import type { Conversation as LocalConversation, ConversationAccessLevel } from "@/types/a2a";
import { getAgentId,isDynamicAgentConversation } from "@/types/a2a";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import type { Conversation } from "@/types/mongodb";
import { useSession } from "next-auth/react";
import { useParams,useRouter } from "next/navigation";
import { useEffect,useRef,useState } from "react";

/**
 * ChatContainer - renders the appropriate chat view based on conversation type.
 * This component lives in the layout and persists across conversation switches,
 * preventing the visual "refresh" when navigating between conversations.
 */
export function ChatContainer() {
  const params = useParams();
  const router = useRouter();
  const { data: session } = useSession();
  
  // Get uuid from params - this will be undefined on /chat (redirect page)
  const uuid = params?.uuid as string | undefined;

  const [agentInfo, setAgentInfo] = useState<DynamicAgentConfig | null>(null);
  // Track when a dynamic agent has been deleted but conversation still references it
  const [agentNotFound, setAgentNotFound] = useState(false);

  // Only subscribe to stable functions — NOT to `conversations`.
  const { setActiveConversation, loadMessagesFromServer } = useChatStore();

  // Subscribe reactively to agent participant for this conversation.
  const selectedAgentId = useChatStore(
    (s) => {
      if (!uuid) return undefined;
      const conv = s.conversations.find((c) => c.id === uuid);
      return conv ? getAgentId(conv) : undefined;
    }
  );

  const storageMode = getStorageMode();

  // Reactive selector: true when the store has messages for this UUID.
  const storeHasMessages = useChatStore(
    (s) => {
      if (!uuid) return false;
      const conv = s.conversations.find((c) => c.id === uuid);
      return !!(conv?.messages && conv.messages.length > 0);
    }
  );

  // Check store imperatively for initial state
  const getExistingConv = () => {
    if (!uuid) return undefined;
    return useChatStore.getState().conversations.find((c) => c.id === uuid);
  };
  const existingConv = getExistingConv();
  const existingHasMessages = !!(existingConv?.messages && existingConv.messages.length > 0);

  const [conversation, setConversation] = useState<Conversation | LocalConversation | null>(existingConv || null);
  const [accessLevel, setAccessLevel] = useState<ConversationAccessLevel | null>(existingConv?.accessLevel ?? null);
  const [fetchInProgress, setFetchInProgress] = useState(
    storageMode === 'mongodb' && !existingHasMessages
  );
  const [fetchDone, setFetchDone] = useState(existingHasMessages);
  const [error, setError] = useState<string | null>(null);

  // Track the current uuid to detect conversation switches
  const currentUuidRef = useRef<string | undefined>(uuid);

  // Track which (uuid, agentId) combination we've already fetched
  const fetchedAgentRef = useRef<{ uuid: string; agentId: string } | null>(null);

  // Reset state when uuid changes (conversation switch)
  useEffect(() => {
    if (uuid && uuid !== currentUuidRef.current) {
      currentUuidRef.current = uuid;
      
      // Check if new conversation is already in store
      const newConv = useChatStore.getState().conversations.find((c) => c.id === uuid);
      const hasMessages = !!(newConv?.messages && newConv.messages.length > 0);
      
      setConversation(newConv || null);
      setFetchInProgress(storageMode === 'mongodb' && !hasMessages);
      setFetchDone(hasMessages);
      setError(null);
      setAccessLevel(null);
      setAgentNotFound(false);
      // Don't reset agentInfo - let the agent fetch effect handle it
    }
  }, [uuid, storageMode]);

  // Load conversation from MongoDB or localStorage
  useEffect(() => {
    if (typeof window === 'undefined' || !uuid) {
      return;
    }

    async function loadConversation() {
      if (!uuid || typeof uuid !== 'string') {
        setError("Invalid conversation ID");
        setFetchInProgress(false);
        setFetchDone(true);
        return;
      }

      const localConv = useChatStore.getState().conversations.find((c) => c.id === uuid);
      if (localConv) {
        setConversation(localConv);
        setActiveConversation(uuid);

        // Derive access level from store data
        if (localConv.accessLevel) {
          setAccessLevel(localConv.accessLevel);
        } else if (localConv.owner_id && session?.user?.email && localConv.owner_id !== session.user.email) {
          if (localConv.sharing?.shared_with?.includes(session.user.email) ||
              (localConv.sharing?.shared_with_teams?.length ?? 0) > 0) {
            setAccessLevel('shared_readonly');
          }
        }

        const hasMessages = localConv.messages && localConv.messages.length > 0;

        if (hasMessages) {
          console.log("[ChatContainer] Found conversation in store with messages, loading instantly");
          setFetchInProgress(false);
          setFetchDone(true);

          if (storageMode === 'mongodb') {
            loadMessagesFromServer(uuid).catch((err) => {
              console.warn('[ChatContainer] Failed to sync messages from server:', err);
            });
          }
        } else if (storageMode === 'mongodb') {
          console.log("[ChatContainer] Found conversation in store but no messages, loading from MongoDB...");
          try {
            await loadMessagesFromServer(uuid, { force: true });
          } catch (err) {
            console.warn('[ChatContainer] Failed to load messages from server:', err);
          } finally {
            setFetchInProgress(false);
            setFetchDone(true);
          }
        } else {
          setFetchInProgress(false);
          setFetchDone(true);
        }
        return;
      }

      console.log("[ChatContainer] Conversation not in store, loading from backend...");

      try {
        if (storageMode === 'mongodb') {
          console.log("[ChatContainer] Loading from MongoDB...");
          try {
            const conv = await apiClient.getConversation(uuid) as Conversation & { access_level?: ConversationAccessLevel };
            if (conv.access_level) {
              setAccessLevel(conv.access_level);
            }
            const localConv: LocalConversation = {
              id: conv._id,
              title: conv.title,
              createdAt: new Date(conv.created_at),
              updatedAt: new Date(conv.updated_at),
              messages: [],
              streamEvents: [],
              participants: conv.participants || [],
              // assisted-by Codex Codex-sonnet-4-6
              // Direct-open shared chats may skip the list route; keep share metadata for sidebar badges.
              owner_id: conv.owner_id,
              accessLevel: conv.access_level,
              sharing: conv.sharing,
              metadata: conv.metadata,
            };

            useChatStore.setState((state) => ({
              conversations: [localConv, ...state.conversations.filter(c => c.id !== uuid)],
            }));

            setConversation(localConv);

            try {
              await loadMessagesFromServer(uuid);
            } catch (err) {
              console.warn('[ChatContainer] Failed to load messages from server:', err);
            }
          } catch (apiErr) {
            const storeConv = useChatStore.getState().conversations.find(c => c.id === uuid);
            if (storeConv) {
              console.log("[ChatContainer] Conversation appeared in store during fetch");
              setConversation(storeConv);
              return;
            }

            if (getErrorMessage(apiErr, "")?.includes('not found') || getErrorMessage(apiErr, "")?.includes('404')) {
              console.log("[ChatContainer] Conversation not found in MongoDB (expected for new conversations)");
            } else {
              console.warn("[ChatContainer] Failed to load from MongoDB:", getErrorMessage(apiErr, ""));
            }
            const newConv: LocalConversation = {
              id: uuid,
              title: "New Conversation",
              createdAt: new Date(),
              updatedAt: new Date(),
              messages: [],
              streamEvents: [],
              participants: [],
            };

            useChatStore.setState((state) => ({
              conversations: [newConv, ...state.conversations.filter(c => c.id !== uuid)],
            }));

            setConversation(newConv);
          }
        } else {
          console.log("[ChatContainer] MongoDB unavailable, showing empty conversation");
          const newConv: LocalConversation = {
            id: uuid,
            title: "New Conversation",
            createdAt: new Date(),
            updatedAt: new Date(),
            messages: [],
            streamEvents: [],
            participants: [],
          };

          useChatStore.setState((state) => ({
            conversations: [newConv, ...state.conversations.filter(c => c.id !== uuid)],
          }));

          setConversation(newConv);
        }
      } catch (err) {
        console.error("[ChatContainer] Unexpected error:", err);
        const newConv: LocalConversation = {
          id: uuid,
          title: "New Conversation",
          createdAt: new Date(),
          updatedAt: new Date(),
          messages: [],
          streamEvents: [],
          participants: [],
        };

        useChatStore.setState((state) => ({
          conversations: [newConv, ...state.conversations.filter(c => c.id !== uuid)],
        }));

        setConversation(newConv);
      } finally {
        setActiveConversation(uuid);
        setFetchInProgress(false);
        setFetchDone(true);
      }
    }

    loadConversation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uuid, storageMode, setActiveConversation, loadMessagesFromServer]);

  // Fetch agent info when a dynamic agent is selected
  useEffect(() => {
    if (!uuid) {
      setAgentInfo(null);
      setAgentNotFound(false);
      return;
    }

    if (!selectedAgentId) {
      const conversationInStore = useChatStore.getState().conversations.find((c) => c.id === uuid);
      if (conversationInStore && !isDynamicAgentConversation(conversationInStore)) {
        setAgentInfo(null);
        setAgentNotFound(false);
      }
      return;
    }

    // Skip fetch if we already have agent info for this exact (uuid, agentId) combo.
    // BUT if agentInfo is null (e.g., returning to conversation after state cleared),
    // we must re-fetch even if ref matches.
    if (
      fetchedAgentRef.current?.uuid === uuid &&
      fetchedAgentRef.current?.agentId === selectedAgentId &&
      agentInfo !== null
    ) {
      return;
    }

    fetchedAgentRef.current = { uuid, agentId: selectedAgentId };

    async function fetchAgentInfo() {
      try {
        const response = await fetch(`/api/dynamic-agents/agents/${selectedAgentId}`);
        if (response.ok) {
          const data = await response.json();
          const agent = data.data as DynamicAgentConfig;
          setAgentInfo(agent);
          setAgentNotFound(false);
        } else if (response.status === 404) {
          console.warn(`[ChatContainer] Agent ${selectedAgentId} not found (deleted)`);
          setAgentInfo(null);
          setAgentNotFound(true);
        } else {
          console.error(`[ChatContainer] Failed to fetch agent info: ${response.status}`);
          setAgentInfo(null);
          setAgentNotFound(false);
        }
      } catch (err) {
        console.error("Failed to fetch agent info:", err);
        setAgentInfo(null);
        setAgentNotFound(false);
      }
    }

    fetchAgentInfo();
    // Note: agentInfo in deps intentionally triggers re-fetch when agentInfo becomes null
    // (e.g., on page refresh or after navigating away and back)
  }, [uuid, selectedAgentId, agentInfo]);

  // If no uuid, render nothing (this is the /chat redirect page case)
  if (!uuid) {
    return null;
  }

  // Show loading spinner only for initial load
  const isInitialLoad = fetchInProgress && !conversation;
  if (isInitialLoad) {
    return (
      <div className="flex-1 flex w-full items-center justify-center">
        <CAIPESpinner size="lg" message="Loading conversation..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <p className="text-sm text-destructive">{error}</p>
          <button
            onClick={() => router.push("/chat")}
            className="text-sm text-primary hover:underline"
          >
            Go to new conversation
          </button>
        </div>
      </div>
    );
  }

  const isReadOnly = accessLevel === 'admin_audit' || accessLevel === 'shared_readonly';
  const readOnlyReason = accessLevel === 'admin_audit' ? 'admin_audit' : accessLevel === 'shared_readonly' ? 'shared_readonly' : undefined;

  // Only show loading if we haven't finished fetching yet. After fetchDone=true,
  // having no messages is legitimate (e.g., messages were deleted) — not a loading state.
  const isLoadingMessages = fetchInProgress || (storageMode === 'mongodb' && !storeHasMessages && !fetchDone && conversation?.title !== "New Conversation");

  // Legacy conversations from the deprecated supervisor-agent era have no agent
  // participant (participants: []). Treat them the same as conversations whose
  // agent was later deleted: show the full chat history in read-only mode with
  // an "agent deleted" banner and a CTA to start a new conversation.
  const effectiveAgentId = selectedAgentId ?? "deprecated-supervisor-agent";
  const isAgentGone = agentNotFound || !selectedAgentId;

  return (
    <ChatView
      conversationId={uuid}
      selectedAgentId={effectiveAgentId}
      agent={agentInfo}
      agentNotFound={isAgentGone}
      readOnly={isReadOnly}
      readOnlyReason={readOnlyReason}
      isLoadingMessages={isLoadingMessages}
    />
  );
}
