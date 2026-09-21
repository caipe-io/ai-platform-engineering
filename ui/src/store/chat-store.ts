import { getErrorMessage } from "@/lib/error-utils";
import { create, type StateCreator } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { Conversation, ChatMessage, MessageFeedback, TurnStatus, getAgentId, buildParticipants } from "@/types/a2a";
import { StreamEvent } from "@/lib/streaming/types";
import { generateId } from "@/lib/utils";
import type { StreamAdapter } from "@/lib/streaming";
import { apiClient } from "@/lib/api-client";
import { getStorageMode, shouldUseLocalStorage } from "@/lib/storage-config";
import type { Artifact, Message as StoredMessage, StoredStreamEvent } from "@/types/mongodb";
import { MAX_INLINE_PERSIST_BYTES } from "@/lib/file-attachments";

const LAST_ACTIVE_CONVERSATION_KEY = "caipe-chat-last-active-conversation";

export function getLastActiveConversationId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(LAST_ACTIVE_CONVERSATION_KEY);
}

/** Best-effort chat URL: resume last active conversation when possible. */
export function resolveChatNavigationPath(state: {
  conversations: Conversation[];
  activeConversationId: string | null;
}): string {
  const { conversations, activeConversationId } = state;
  const lastActive = activeConversationId ?? getLastActiveConversationId();
  if (lastActive) {
    if (
      conversations.length === 0 ||
      conversations.some((conversation) => conversation.id === lastActive)
    ) {
      return `/chat/${lastActive}`;
    }
  }
  if (conversations.length > 0) {
    const latest = [...conversations].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    )[0];
    return `/chat/${latest.id}`;
  }
  return "/chat";
}

function persistLastActiveConversationId(id: string | null): void {
  if (typeof window === "undefined") return;
  if (id) {
    window.localStorage.setItem(LAST_ACTIVE_CONVERSATION_KEY, id);
  } else {
    window.localStorage.removeItem(LAST_ACTIVE_CONVERSATION_KEY);
  }
}

/**
 * True when the server says the conversation does not exist — expected for
 * conversations that only ever lived in local state. Any other failure (403 on
 * a conversation shared with the viewer, 5xx, network) means the row survives
 * on the server and a local-only removal would silently come back.
 */
function isConversationMissingError(error: unknown): boolean {
  // APIClientError carries the HTTP status; fall back to the message for
  // errors raised outside the API client.
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status === 404;
  const message = getErrorMessage(error, "");
  return message.includes("404") || message.includes("not found");
}

// Track streaming state per conversation
interface StreamingState {
  conversationId: string;
  messageId: string;
  /** Abortable handle for the active stream (wraps the stream adapter's abort). */
  client: { abort: () => void };
  // For Dynamic Agents: adapter reference for backend cancellation
  streamAdapter?: StreamAdapter;
}

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  isStreaming: boolean;
  streamingConversations: Map<string, StreamingState>;
  pendingMessage: string | null; // Message to auto-submit when the chat panel mounts

  // Conversations with new responses the user hasn't viewed yet
  unviewedConversations: Set<string>;

  // Conversations where the agent is waiting for user input (HITL)
  inputRequiredConversations: Set<string>;

  // Actions
  createConversation: (agentId: string) => Promise<string>;
  setActiveConversation: (id: string) => void;
  addMessage: (conversationId: string, message: Omit<ChatMessage, "id" | "timestamp">, turnId?: string, messageId?: string) => string;
  updateMessage: (conversationId: string, messageId: string, updates: Partial<ChatMessage>) => void;
  appendToMessage: (conversationId: string, messageId: string, content: string) => void;
  setStreaming: (streaming: boolean) => void;
  setConversationStreaming: (conversationId: string, state: StreamingState | null) => void;
  isConversationStreaming: (conversationId: string) => boolean;
  cancelConversationRequest: (conversationId: string) => void;
  // Stream events (for Dynamic Agents)
  addStreamEvent: (event: StreamEvent, conversationId?: string) => void;
  clearStreamEvents: (conversationId?: string) => void;
  getConversationStreamEvents: (conversationId: string) => StreamEvent[];
  deleteConversation: (id: string) => Promise<void>;
  clearAllConversations: () => void;
  getActiveConversation: () => Conversation | undefined;
  updateMessageFeedback: (conversationId: string, messageId: string, feedback: MessageFeedback) => void;
  updateConversationSharing: (conversationId: string, sharing: Conversation['sharing']) => void;
  updateConversationTitle: (conversationId: string, title: string) => Promise<void>;
  setPendingMessage: (message: string | null) => void;
  consumePendingMessage: () => string | null;
  loadConversationsFromServer: () => Promise<void>; // Load conversations from server (MongoDB mode only)
  saveMessagesToServer: (conversationId: string, options?: { skipNonFinal?: boolean }) => Promise<void>; // Save messages to MongoDB after streaming
  loadMessagesFromServer: (conversationId: string, options?: { force?: boolean }) => Promise<void>; // Load messages from MongoDB when opening conversation
  evictOldMessageContent: (conversationId: string, messageIdsToEvict: string[]) => void; // Evict content from old messages to free memory

  // Unviewed conversation actions
  markConversationUnviewed: (conversationId: string) => void;
  clearConversationUnviewed: (conversationId: string) => void;
  hasUnviewedMessages: (conversationId: string) => boolean;

  // Input-required conversation actions (HITL)
  markConversationInputRequired: (conversationId: string) => void;
  clearConversationInputRequired: (conversationId: string) => void;
  isConversationInputRequired: (conversationId: string) => boolean;
}

interface DebugLocalConversation {
  id?: string;
  title?: string;
  messages?: Array<Partial<ChatMessage>>;
}

interface CaipeDebugTools {
  messages: () => unknown;
  compare: () => Promise<unknown>;
  mongo: () => Promise<unknown>;
  localStorage: () => void;
  storageMode: () => unknown;
}

declare global {
  interface Window {
    __caipeDebug?: CaipeDebugTools;
  }
}

// Coalesce concurrent conversation-list fetches (Sidebar + /chat redirect race).
let loadConversationsInFlight: Promise<void> | null = null;

// NOTE: savedMessageIds / savedMessageState tracking removed.
// With the upsert-based API, saveMessagesToServer sends ALL messages every
// time and the server handles insert-or-update via message_id. This eliminates
// the "two sources of truth" drift that caused stale content in MongoDB.

// Track in-flight and recently completed message loads to prevent:
// 1. Concurrent requests for the same conversation
// 2. Rapid re-fetches caused by React re-render loops (useEffect → store update → re-render)
// Maps conversationId → timestamp of last completed load. Calls within the cooldown
// window are skipped unless force=true (manual reload).
const messageLoadState = new Map<string, { inFlight: boolean; lastLoadedAt: number }>();
const MESSAGE_LOAD_COOLDOWN_MS = 5000; // 5 second cooldown between automatic syncs

// Track event counts per conversation for periodic saves during long streaming sessions.
// When event count hits the threshold, a background save is triggered to avoid data loss
// if the user closes the tab or the browser crashes mid-stream.
const eventCountSinceLastSave = new Map<string, number>();
const PERIODIC_SAVE_EVENT_THRESHOLD = 20; // Save every 20 events during streaming (reduced from 50 for better crash recovery)

// Track conversations that have a pending save (streaming just completed, save
// is scheduled but not yet flushed to MongoDB). During this window, MongoDB
// contains stale intermediate content — loadMessagesFromServer must NOT
// overwrite the correct in-memory state with that stale data.
const pendingSaveTimestamps = new Map<string, number>();
const PENDING_SAVE_GRACE_MS = 5000; // 5 second grace period after streaming ends

// Serialize stream event for MongoDB storage (strip raw data, preserve structured fields)
function serializeStreamEvent(event: StreamEvent): StoredStreamEvent {
  return {
    id: event.id,
    timestamp: event.timestamp,
    type: event.type,
    taskId: event.taskId,
    isFinal: event.isFinal,
    namespace: event.namespace,
    // Structured event data
    toolData: event.toolData,
    warningData: event.warningData,
    inputRequiredData: event.inputRequiredData,
    // Content fields
    content: event.content,
    displayContent: event.displayContent,
    // HITL support
    contextId: event.contextId,
    metadata: event.metadata,
    // Omit event.raw to avoid circular refs and large payloads
  };
}

// Create store with conditional persistence
const storeImplementation: StateCreator<ChatState> = (set, get) => ({
      conversations: [],
      activeConversationId: null,
      isStreaming: false,
      streamingConversations: new Map<string, StreamingState>(),
      pendingMessage: null,
      unviewedConversations: new Set<string>(),
      inputRequiredConversations: new Set<string>(),

      createConversation: async (agentId: string) => {
        const storageMode = getStorageMode();
        const normalizedAgentId = agentId.trim();
        if (!normalizedAgentId) {
          throw new Error("agentId is required to create a chat conversation");
        }

        let id: string;

        if (storageMode === 'mongodb') {
          // MongoDB mode: server owns ID generation
          const result = await apiClient.createConversation({
            title: 'New Conversation',
            client_type: 'webui',
            agent_id: normalizedAgentId,
          });
          id = result.conversation._id;
        } else {
          // localStorage mode: generate locally
          id = generateId();
        }

        const newConversation: Conversation = {
          id,
          title: "New Conversation",
          createdAt: new Date(),
          updatedAt: new Date(),
          messages: [],
          streamEvents: [],
          participants: buildParticipants(normalizedAgentId),
        };

        // Update local state
        set((state: ChatState) => ({
          conversations: [newConversation, ...state.conversations],
          activeConversationId: id,
        }));
        persistLastActiveConversationId(id);

        return id;
      },

      setActiveConversation: (id: string) => {
        const prev = get();
        const newUnviewed = new Set(prev.unviewedConversations);
        newUnviewed.delete(id);
        const newInputRequired = new Set(prev.inputRequiredConversations);
        newInputRequired.delete(id);
        set({
          activeConversationId: id,
          unviewedConversations: newUnviewed,
          inputRequiredConversations: newInputRequired,
        });
        persistLastActiveConversationId(id);
      },

      addMessage: (conversationId: string, message: Omit<ChatMessage, "id" | "timestamp">, turnId?: string, messageId?: string) => {
        const msgId = messageId || generateId();

        // Generate turnId for user messages, use provided turnId for assistant messages
        let messageTurnId = turnId;
        if (message.role === "user" && !turnId) {
          messageTurnId = generateId();
        }

        const newMessage: ChatMessage = {
          ...message,
          id: msgId,
          timestamp: new Date(),
          turnId: messageTurnId,
        };

        // Check if this is the first user message and we should auto-generate title
        const state = get();
        const conversation = state.conversations.find((c: Conversation) => c.id === conversationId);
        const isFirstUserMessage = conversation && conversation.messages.length === 0 && message.role === "user";
        const newTitle = isFirstUserMessage
          ? message.content.substring(0, 50).trim() || "New Conversation"
          : undefined;

        set((state: ChatState) => {
          return {
            conversations: state.conversations.map((conv: Conversation) =>
              conv.id === conversationId
                ? {
                    ...conv,
                    messages: [...conv.messages, newMessage],
                    updatedAt: new Date(),
                    title: newTitle || conv.title,
                  }
                : conv
            ),
          };
        });

        // If title was auto-generated, save it to MongoDB
        if (newTitle && newTitle !== "New Conversation") {
          const { updateConversationTitle } = get();
          updateConversationTitle(conversationId, newTitle).catch((error) => {
            console.error('[ChatStore] Failed to save auto-generated title:', error);
          });
        }

        return msgId;
      },

      updateMessage: (conversationId: string, messageId: string, updates: Partial<ChatMessage>) => {
        set((state: ChatState) => ({
          conversations: state.conversations.map((conv: Conversation) =>
            conv.id === conversationId
              ? {
                  ...conv,
                  messages: conv.messages.map((msg: ChatMessage) =>
                    msg.id === messageId ? { ...msg, ...updates } : msg
                  ),
                  updatedAt: new Date(),
                }
              : conv
          ),
        }));
      },

      appendToMessage: (conversationId: string, messageId: string, content: string) => {
        set((state: ChatState) => ({
          conversations: state.conversations.map((conv: Conversation) =>
            conv.id === conversationId
              ? {
                  ...conv,
                  messages: conv.messages.map((msg: ChatMessage) =>
                    msg.id === messageId
                      ? { ...msg, content: msg.content + content }
                      : msg
                  ),
                }
              : conv
          ),
        }));
      },

      setStreaming: (streaming: boolean) => {
        set({ isStreaming: streaming });
      },

      setConversationStreaming: (conversationId: string, state: StreamingState | null) => {
        set((prev: ChatState) => {
          const newMap = new Map(prev.streamingConversations);
          if (state) {
            newMap.set(conversationId, state);
            // Clear input-required when streaming resumes (user submitted input)
            const newInputRequired = new Set(prev.inputRequiredConversations);
            newInputRequired.delete(conversationId);
            console.log(`[Store] Started streaming for conversation: ${conversationId}`);
            return {
              streamingConversations: newMap,
              isStreaming: true,
              inputRequiredConversations: newInputRequired,
            };
          }
          newMap.delete(conversationId);
          console.log(`[Store] Stopped streaming for conversation: ${conversationId}, remaining: ${newMap.size}`);
          const newIsStreaming = newMap.size > 0;
          console.log(`[Store] Global isStreaming: ${newIsStreaming}`);
          return {
            streamingConversations: newMap,
            isStreaming: newIsStreaming,
          };
        });

        // When streaming completes, save messages to MongoDB and mark unviewed
        if (!state) {
          // Mark as unviewed if the user is looking at a different conversation
          const current = get();
          if (current.activeConversationId !== conversationId) {
            const newUnviewed = new Set(current.unviewedConversations);
            newUnviewed.add(conversationId);
            set({ unviewedConversations: newUnviewed });
            console.log(`[Store] Marked conversation as unviewed: ${conversationId.substring(0, 8)}`);
          }

          // Reset periodic save counter for this conversation
          eventCountSinceLastSave.delete(conversationId);
          // Mark save as pending — prevents loadMessagesFromServer from
          // overwriting the correct in-memory state with stale MongoDB data
          // before this save completes.
          pendingSaveTimestamps.set(conversationId, Date.now());
          // Use setTimeout to let the final message update settle before saving
          setTimeout(() => {
            get().saveMessagesToServer(conversationId)
              .then(() => {
                pendingSaveTimestamps.delete(conversationId);
                console.log(`[ChatStore] Post-stream save completed for: ${conversationId.substring(0, 8)}`);
              })
              .catch((error) => {
                pendingSaveTimestamps.delete(conversationId);
                console.error('[ChatStore] Background save failed:', error);
              });
          }, 500);
        }
      },

      isConversationStreaming: (conversationId: string) => {
        return get().streamingConversations.has(conversationId);
      },

      cancelConversationRequest: (conversationId: string) => {
        const state = get();
        const streamingState = state.streamingConversations.get(conversationId);
        if (streamingState) {
          // Get conversation to check if it's a Dynamic Agent
          const conv = state.conversations.find((c: Conversation) => c.id === conversationId);
          
          // For Dynamic Agents, send backend cancel request before aborting client
          if (streamingState.streamAdapter) {
            const agentId = conv ? getAgentId(conv) : undefined;
            if (agentId) {
              console.log(`[ChatStore] Cancelling Dynamic Agent stream: conv=${conversationId.substring(0, 8)}, agent=${agentId}`);
              // Fire-and-forget backend cancel - the abort below will close the client connection
              streamingState.streamAdapter.cancelStream(conversationId, agentId)
                .then((cancelled) => {
                  console.log(`[ChatStore] Backend cancel result: cancelled=${cancelled}`);
                })
                .catch((error) => {
                  console.error('[ChatStore] Backend cancel failed:', error);
                });
            } else {
              console.warn(`[ChatStore] Cannot cancel backend stream: no agent participant found for conv=${conversationId.substring(0, 8)}`);
            }
          }

          // Abort the active stream (Dynamic Agent wrapper)
          streamingState.client.abort();
          // Remove from streaming map
          const newMap = new Map(state.streamingConversations);
          newMap.delete(conversationId);
          set({
            streamingConversations: newMap,
            isStreaming: newMap.size > 0,
          });
          // Mark the message as cancelled with interrupted status
          const msg = conv?.messages.find((m: ChatMessage) => m.id === streamingState.messageId);
          if (msg && !msg.isFinal) {
            // CRITICAL: Copy conversation-level streamEvents to the message for persistence.
            // During streaming, events are collected at conversation.streamEvents. When we cancel,
            // we must attach them to the message so historical messages render timelines correctly.
            const turnStreamEvents = conv?.streamEvents || [];
            state.appendToMessage(conversationId, streamingState.messageId, "\n\n*Request cancelled*");
            state.updateMessage(conversationId, streamingState.messageId, { 
              isFinal: true,
              turnStatus: "interrupted",
              streamEvents: turnStreamEvents.length > 0 ? turnStreamEvents : undefined,
            });
          }

          // Reset periodic save counter and save to MongoDB after cancel —
          // previously skipped because cancel bypassed setConversationStreaming(null).
          eventCountSinceLastSave.delete(conversationId);
          pendingSaveTimestamps.set(conversationId, Date.now());
          setTimeout(() => {
            get().saveMessagesToServer(conversationId)
              .then(() => {
                pendingSaveTimestamps.delete(conversationId);
                console.log(`[ChatStore] Post-cancel save completed for: ${conversationId.substring(0, 8)}`);
              })
              .catch((error) => {
                pendingSaveTimestamps.delete(conversationId);
                console.error('[ChatStore] Save after cancel failed:', error);
              });
          }, 500);
        }
      },

      // ═══════════════════════════════════════════════════════════════
      // Stream Events (for Dynamic Agents)
      // ═══════════════════════════════════════════════════════════════

      addStreamEvent: (event: StreamEvent, conversationId?: string) => {
        const convId = conversationId || get().activeConversationId;
        if (!convId) return;

        set((prev: ChatState) => {
          return {
            conversations: prev.conversations.map((c: Conversation) =>
              c.id === convId
                ? {
                    ...c,
                    streamEvents: [...(c.streamEvents || []), event],
                  }
                : c
            ),
          };
        });

        // Mark conversation as input-required when an input_required event arrives
        if (event.type === 'input_required') {
          const current = get();
          const newInputRequired = new Set(current.inputRequiredConversations);
          newInputRequired.add(convId);
          set({ inputRequiredConversations: newInputRequired });
          console.log(`[Store] Marked conversation as input-required: ${convId.substring(0, 8)}`);
        }

        // Periodic save: trigger a background save every PERIODIC_SAVE_EVENT_THRESHOLD
        // events to avoid data loss during long streaming sessions.
        const count = (eventCountSinceLastSave.get(convId) || 0) + 1;
        eventCountSinceLastSave.set(convId, count);
        if (count >= PERIODIC_SAVE_EVENT_THRESHOLD) {
          eventCountSinceLastSave.set(convId, 0);
          console.log(`[ChatStore] Periodic save triggered after ${PERIODIC_SAVE_EVENT_THRESHOLD} events for: ${convId}`);
          get().saveMessagesToServer(convId, { skipNonFinal: true }).catch((error) => {
            console.error('[ChatStore] Periodic save failed:', error);
          });
        }
      },

      clearStreamEvents: (conversationId?: string) => {
        if (conversationId) {
          set((prev: ChatState) => ({
            conversations: prev.conversations.map((conv: Conversation) =>
              conv.id === conversationId
                ? {
                    ...conv,
                    streamEvents: [],
                  }
                : conv
            ),
          }));
        }
      },

      getConversationStreamEvents: (conversationId: string) => {
        const conv = get().conversations.find((c: Conversation) => c.id === conversationId);
        return conv?.streamEvents || [];
      },

      deleteConversation: async (id: string) => {
        const storageMode = await getStorageMode();

        // Snapshot for rollback. The removal below is optimistic, so a server
        // rejection (e.g. a conversation shared with — but not owned by — the
        // viewer, which returns 403) must not leave the row hidden locally
        // while it still exists on the server: it would silently reappear on
        // the next hydrate.
        const previousState = get();
        const removedConversation = previousState.conversations.find((c: Conversation) => c.id === id);
        const removedIndex = previousState.conversations.findIndex((c: Conversation) => c.id === id);
        const previousActiveId = previousState.activeConversationId;

        // Delete from local state first (instant UI update)
        set((state: ChatState) => {
          const wasActiveConversation = state.activeConversationId === id;

          // Find the index of the conversation being deleted
          const deletedIndex = state.conversations.findIndex((c: Conversation) => c.id === id);
          const newConversations = state.conversations.filter((c: Conversation) => c.id !== id);

          // If this was the active conversation, select the next one intelligently
          let newActiveId = state.activeConversationId;
          if (wasActiveConversation) {
            if (newConversations.length === 0) {
              // No conversations left
              newActiveId = null;
            } else if (deletedIndex >= newConversations.length) {
              // Was last in list, select the new last one (previous conversation)
              newActiveId = newConversations[newConversations.length - 1].id;
            } else {
              // Select the conversation that took the deleted one's place (next in list)
              newActiveId = newConversations[deletedIndex].id;
            }
          }

          return {
            conversations: newConversations,
            activeConversationId: newActiveId,
          };
        });
        const nextActiveId = get().activeConversationId;
        persistLastActiveConversationId(nextActiveId);

        // In MongoDB mode, also delete from server
        if (storageMode === 'mongodb') {
          try {
            await apiClient.deleteConversation(id);
            console.log('[ChatStore] Deleted conversation from MongoDB:', id);
          } catch (error) {
            // 404 is expected for conversations that were never saved to MongoDB
            if (isConversationMissingError(error)) {
              console.log('[ChatStore] Conversation not in MongoDB (expected for new conversations):', id);
              return;
            }

            // The server still holds the conversation — restore it so the list
            // matches the server, and let the caller report the failure.
            console.error('[ChatStore] Failed to delete from MongoDB:', error);
            if (removedConversation) {
              set((state: ChatState) => {
                if (state.conversations.some((c: Conversation) => c.id === id)) return state;
                const restored = [...state.conversations];
                restored.splice(Math.min(Math.max(removedIndex, 0), restored.length), 0, removedConversation);
                return {
                  conversations: restored,
                  // Only undo the auto-advance this call made; leave any
                  // selection the user changed in the meantime alone.
                  activeConversationId:
                    state.activeConversationId === nextActiveId
                      ? previousActiveId
                      : state.activeConversationId,
                };
              });
              persistLastActiveConversationId(get().activeConversationId);
            }
            throw error;
          }
        }
      },

      clearAllConversations: () => {
        set({
          conversations: [],
          activeConversationId: null,
        });
        persistLastActiveConversationId(null);
      },

      getActiveConversation: () => {
        const state = get();
        return state.conversations.find((c: Conversation) => c.id === state.activeConversationId);
      },

      updateMessageFeedback: (conversationId: string, messageId: string, feedback: MessageFeedback) => {
        set((state: ChatState) => ({
          conversations: state.conversations.map((conv: Conversation) =>
            conv.id === conversationId
              ? {
                  ...conv,
                  messages: conv.messages.map((msg: ChatMessage) =>
                    msg.id === messageId ? { ...msg, feedback } : msg
                  ),
                  updatedAt: new Date(),
                }
              : conv
          ),
        }));
      },

      updateConversationSharing: (conversationId: string, sharing: Conversation['sharing']) => {
        set((state: ChatState) => ({
          conversations: state.conversations.map((conv: Conversation) =>
            conv.id === conversationId
              ? {
                  ...conv,
                  sharing,
                  updatedAt: new Date(),
                }
              : conv
          ),
        }));
        console.log('[ChatStore] Updated conversation sharing:', conversationId, sharing);
      },

      updateConversationTitle: async (conversationId: string, title: string) => {
        const storageMode = await getStorageMode();

        // Update local state immediately (optimistic update)
        set((state: ChatState) => ({
          conversations: state.conversations.map((conv: Conversation) =>
            conv.id === conversationId
              ? {
                  ...conv,
                  title,
                  updatedAt: new Date(),
                }
              : conv
          ),
        }));

        // In MongoDB mode, also update on server
        if (storageMode === 'mongodb') {
          try {
            await apiClient.updateConversation(conversationId, { title });
            console.log('[ChatStore] Updated conversation title in MongoDB:', conversationId, title);
          } catch (error) {
            console.error('[ChatStore] Failed to update conversation title in MongoDB:', error);
            // Revert optimistic update on error
            set((state) => ({
              conversations: state.conversations.map((conv) =>
                conv.id === conversationId
                  ? {
                      ...conv,
                      title: state.conversations.find(c => c.id === conversationId)?.title || "New Conversation",
                    }
                  : conv
              ),
            }));
          }
        }
      },

      setPendingMessage: (message) => {
        set({ pendingMessage: message });
      },

      consumePendingMessage: () => {
        const state = get();
        const message = state.pendingMessage;
        if (message) {
          set({ pendingMessage: null });
        }
        return message;
      },

      loadConversationsFromServer: async () => {
        const storageMode = getStorageMode();

        // Only load from server in MongoDB mode
        if (storageMode !== 'mongodb') {
          console.log('[ChatStore] localStorage mode - no server sync needed');
          return;
        }

        if (loadConversationsInFlight) {
          console.log('[ChatStore] Joining in-flight conversation load...');
          return loadConversationsInFlight;
        }

        loadConversationsInFlight = (async () => {
        try {
          console.log('[ChatStore] Loading conversations from MongoDB...');
          let response;
          try {
            response = await apiClient.getConversations({ page_size: 100 });
          } catch (apiError) {
            // Check if it's an auth error (expected when not logged in)
            const errorMessage = apiError instanceof Error ? apiError.message : String(apiError);
            if (errorMessage.includes('Unauthorized') || errorMessage.includes('401')) {
              console.log('[ChatStore] User not authenticated - using local storage only');
            } else {
              console.error('[ChatStore] API call failed:', {
                error: apiError,
                errorMessage,
                errorStack: apiError instanceof Error ? apiError.stack : undefined
              });
            }
            // Don't clear conversations on API error - preserve what we have
            return;
          }

          console.log('[ChatStore] API Response:', {
            responseType: typeof response,
            responseIsNull: response === null,
            responseIsUndefined: response === undefined,
            responseIsEmpty: response && Object.keys(response).length === 0,
            hasItems: !!response?.items,
            itemsLength: response?.items?.length,
            total: response?.total,
            page: response?.page,
            pageSize: response?.page_size,
            hasMore: response?.has_more,
            keys: response ? Object.keys(response) : [],
            fullResponse: JSON.stringify(response).substring(0, 500)
          });

          // Validate response structure
          // API client extracts data, so response is PaginatedResponse: { items: [...], total, page, page_size, has_more }
          if (!response || (typeof response === 'object' && Object.keys(response).length === 0)) {
            console.error('[ChatStore] No response or empty response from MongoDB API');
            // Don't clear conversations - preserve what we have
            return;
          }

          if (!response.items || !Array.isArray(response.items)) {
            console.error('[ChatStore] Invalid response structure from MongoDB API:', {
              response,
              responseType: typeof response,
              hasItems: !!response?.items,
              isArray: Array.isArray(response?.items),
              keys: response ? Object.keys(response) : [],
              stringified: JSON.stringify(response).substring(0, 500)
            });
            // Don't clear existing conversations on invalid response
            return;
          }

          const serverItems = response.items;
          console.log(`[ChatStore] Received ${serverItems.length} conversations from server (total: ${response.total})`);

          // MongoDB is the sole source of truth for the conversation list.
          // Messages start empty — loadMessagesFromServer fills them when the
          // conversation is opened. Only preserve local-only conversations that
          // are actively streaming (just created, server hasn't caught up).
          const currentState = get();

          // Convert server items to local Conversation format
          const serverConversations: Conversation[] = serverItems.map((conv) => {
            // Preserve in-memory messages and events when:
            // 1. The conversation is actively streaming (live stream buffer), OR
            // 2. The conversation already has messages loaded in memory (avoid
            //    discarding data that loadMessagesFromServer already fetched —
            //    otherwise switching tabs wipes the active conversation's content
            //    and the cooldown prevents an immediate re-fetch).
            const isStreaming = currentState.streamingConversations.has(conv._id);
            const isActive = currentState.activeConversationId === conv._id;
            const localConv = currentState.conversations.find(c => c.id === conv._id);
            const hasLoadedMessages = localConv && localConv.messages.length > 0;

            const title = (conv.title && conv.title.trim())
              ? conv.title
              : "New Conversation";

            return {
              id: conv._id,
              title,
              createdAt: new Date(conv.created_at),
              updatedAt: new Date(conv.updated_at),
              // Preserve messages/events when streaming, already loaded, or actively
              // being viewed (prevents race with concurrent loadMessagesFromServer)
              messages: (isStreaming || hasLoadedMessages || isActive) && localConv ? localConv.messages : [],
              streamEvents: (isStreaming || hasLoadedMessages || isActive) && localConv ? (localConv.streamEvents || []) : [],
              participants: conv.participants || [],
              owner_id: conv.owner_id,
              accessLevel: conv.access_level,
              isSharedWithViewer: conv.viewer_has_shared_access,
              sharing: conv.sharing,
              source: conv.source,
              task_id: conv.task_id,
              run_id: conv.run_id,
              metadata: conv.metadata,
            };
          });

          // Keep local-only conversations that should not be discarded:
          // 1. Actively streaming (just created, server hasn't caught up)
          // 2. Currently active (e.g. audit/shared conversations that belong
          //    to another user and won't appear in the current user's server
          //    response). No message-count check — preserving regardless of
          //    whether messages have loaded yet eliminates a race condition
          //    where the refresh fires before loadMessagesFromServer completes.
          const serverIds = new Set(serverConversations.map(c => c.id));
          const localOnlyPreserved = currentState.conversations.filter(
            conv => !serverIds.has(conv.id) && (
              currentState.streamingConversations.has(conv.id) ||
              conv.id === currentState.activeConversationId
            )
          );

          if (localOnlyPreserved.length > 0) {
            console.log(`[ChatStore] Keeping ${localOnlyPreserved.length} local-only conversations (streaming or active audit/shared)`);
          }

          const allConversations = [...serverConversations, ...localOnlyPreserved];
          const sortedConversations = allConversations.sort(
            (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
          );

          // Check if active conversation was deleted on another device
          const activeId = currentState.activeConversationId;
          const activeStillExists = activeId ? sortedConversations.some(c => c.id === activeId) : true;

          set({
            conversations: sortedConversations,
            ...(activeId && !activeStillExists ? {
              activeConversationId: sortedConversations.length > 0 ? sortedConversations[0].id : null,
            } : {}),
          });

          if (activeId && !activeStillExists) {
            persistLastActiveConversationId(get().activeConversationId);
            console.log(`[ChatStore] Active conversation ${activeId.substring(0, 8)} was deleted on another device, switching to first conversation`);
          }

          console.log(`[ChatStore] Loaded ${serverConversations.length} conversations from MongoDB (${localOnlyPreserved.length} local-only preserved)`);
        } catch (error) {
          console.error('[ChatStore] Failed to load conversations from MongoDB:', error);
          console.error('[ChatStore] Error details:', {
            error,
            errorMessage: error instanceof Error ? getErrorMessage(error, "") : String(error),
            errorStack: error instanceof Error ? error.stack : undefined
          });
          // Don't clear conversations on error - preserve what we have
        } finally {
          loadConversationsInFlight = null;
        }
        })();

        return loadConversationsInFlight;
      },

      // Save messages to MongoDB via upsert (idempotent).
      // The API uses updateOne + upsert on message_id, so this can be called
      // multiple times safely — periodic saves during streaming AND the final
      // save after streaming completes all go through the same code path.
      // No localStorage cache, no "saved vs stale" tracking needed.
      //
      // Options:
      //   skipNonFinal: When true, skip saving assistant messages that don't have
      //     isFinal=true. Used by periodic saves during streaming to avoid writing
      //     stale intermediate content to MongoDB. The final save (after streaming
      //     ends) omits this flag so the correct final content is written.
      saveMessagesToServer: async (conversationId: string, options?: { skipNonFinal?: boolean }) => {
        const storageMode = getStorageMode();
        if (storageMode !== 'mongodb') return;

        const state = get();
        const conv = state.conversations.find((c: Conversation) => c.id === conversationId);
        if (!conv || conv.messages.length === 0) return;

        // Stream events during streaming are stored at the conversation level
        // (conv.streamEvents) via addStreamEvent(). To persist them to MongoDB,
        // we attach the conversation-level events to the last assistant message
        // being saved (the one that was just streamed).
        const convStreamEvents = conv.streamEvents || [];
        const lastAssistantIdx = (() => {
          for (let i = conv.messages.length - 1; i >= 0; i--) {
            if (conv.messages[i].role === 'assistant') return i;
          }
          return -1;
        })();

        const toolStartCount = convStreamEvents.filter((e: StreamEvent) => e.type === 'tool_start').length;
        const toolEndCount = convStreamEvents.filter((e: StreamEvent) => e.type === 'tool_end').length;
        console.log(`[Stream-DEBUG] saveMessagesToServer: conv=${conversationId.substring(0, 8)}, msgs=${conv.messages.length}, streamEvents=${convStreamEvents.length} (${toolStartCount} tool_starts, ${toolEndCount} tool_ends), lastAssistantIdx=${lastAssistantIdx}`);

        let savedCount = 0;

        // Only save the current turn (last user message + last assistant message).
        // Messages are append-only: older messages were already persisted by prior
        // saveMessagesToServer calls. Re-saving them all is wasteful and causes
        // request spam (one POST per message × every turn).
        const lastAssistantMsg = lastAssistantIdx >= 0 ? conv.messages[lastAssistantIdx] : null;
        const lastUserIdx = (() => {
          for (let i = conv.messages.length - 1; i >= 0; i--) {
            if (conv.messages[i].role === 'user') return i;
          }
          return -1;
        })();
        const lastUserMsg = lastUserIdx >= 0 ? conv.messages[lastUserIdx] : null;

        const messagesToSave: { msg: typeof conv.messages[0]; idx: number }[] = [];
        if (lastUserMsg) messagesToSave.push({ msg: lastUserMsg, idx: lastUserIdx });
        if (lastAssistantMsg) messagesToSave.push({ msg: lastAssistantMsg, idx: lastAssistantIdx });

        for (const { msg, idx } of messagesToSave) {
          // PERIODIC SAVE GUARD: Skip non-final assistant messages during
          // periodic saves. These messages contain intermediate streaming
          // content that would overwrite (poison) MongoDB. The correct final
          // content is written only by the post-stream save (which omits
          // skipNonFinal), ensuring MongoDB always ends up with the right data.
          if (options?.skipNonFinal && msg.role === 'assistant' && !msg.isFinal) {
            console.log(`[ChatStore] Periodic save: skipping non-final assistant message ${msg.id.substring(0, 8)} (intermediate streaming content)`);
            continue;
          }

          try {
            // Attach conversation-level stream events to the last assistant message.
            let serializedStreamEvents: StoredStreamEvent[] | undefined;
            if (idx === lastAssistantIdx && convStreamEvents.length > 0) {
              serializedStreamEvents = convStreamEvents.map(serializeStreamEvent);
              console.log(`[ChatStore] Attaching ${convStreamEvents.length} conversation-level stream events to assistant message ${msg.id}`);
            }

            // Persist user attachments as artifacts so the upload stays in the
            // transcript across reloads. Inline base64 is capped: above the
            // cap we keep name/mime/size but drop the data (a document chip
            // still renders) to avoid bloating conversation documents.
            const attachmentArtifacts: Artifact[] | undefined = msg.attachments?.length
              ? msg.attachments.map((att) => {
                  const persistData = att.data != null
                    && (att.size == null || att.size <= MAX_INLINE_PERSIST_BYTES);
                  return {
                    type: "attachment",
                    name: att.name,
                    data: {
                      mime_type: att.mime_type,
                      ...(att.size != null && { size: att.size }),
                      ...(persistData && { data: att.data }),
                    },
                  };
                })
              : undefined;

            // The API does upsert on message_id — inserts on first call,
            // updates content/metadata/events on subsequent calls.
            await apiClient.addMessage(conversationId, {
              message_id: msg.id,
              role: msg.role,
              content: msg.content,
              // Include sender identity so shared conversations attribute messages correctly.
              // These are set in $setOnInsert on the API side (immutable after first write).
              ...(msg.senderEmail && { sender_email: msg.senderEmail }),
              ...(msg.senderName && { sender_name: msg.senderName }),
              ...(msg.senderImage && { sender_image: msg.senderImage }),
              metadata: {
                turn_id: msg.turnId || `turn-${Date.now()}`,
                is_final: msg.isFinal ?? false,
                ...(msg.taskId && { task_id: msg.taskId }),
                ...(msg.isInterrupted && { is_interrupted: msg.isInterrupted }),
                ...(msg.turnStatus && { turn_status: msg.turnStatus }),
                // agent_name + latency_ms power the Insights "Favorite Agents"
                // and response-time analytics. Set on the finalized assistant
                // message by DynamicAgentChatPanel.finalizeStreamLoop.
                ...(msg.agentName && { agent_name: msg.agentName }),
                ...(msg.latencyMs != null && { latency_ms: msg.latencyMs }),
              },
              stream_events: serializedStreamEvents,
              ...(attachmentArtifacts && { artifacts: attachmentArtifacts }),
            });

            savedCount++;
          } catch (error) {
            console.error(`[ChatStore] Failed to save message ${msg.id}:`, getErrorMessage(error, ""));
          }
        }

        console.log(`[ChatStore] Upserted ${savedCount} messages (current turn) to MongoDB`);
      },

      // Load messages from MongoDB when opening a conversation.
      // This is called every time a conversation page is navigated to in MongoDB mode.
      // It merges server data (new messages, events) with local state, so it's safe
      // to call multiple times — it won't lose local-only state like feedback.
      loadMessagesFromServer: async (conversationId: string, options?: { force?: boolean }) => {
        const storageMode = getStorageMode();
        if (storageMode !== 'mongodb') return;

        const loadState = messageLoadState.get(conversationId);
        const force = options?.force ?? false;

        // Prevent concurrent loads for the same conversation
        if (loadState?.inFlight) {
          console.log('[ChatStore] Already loading messages for:', conversationId);
          return;
        }

        // CRITICAL: Skip if a post-streaming save is pending.
        // When streaming ends, the correct final content is in the Zustand store
        // but not yet saved to MongoDB. If we fetch from MongoDB now, we'd
        // overwrite the correct in-memory state with stale intermediate content.
        // Only force=true (manual reload) can bypass this guard.
        if (!force) {
          const savePendingSince = pendingSaveTimestamps.get(conversationId);
          if (savePendingSince) {
            const elapsed = Date.now() - savePendingSince;
            if (elapsed < PENDING_SAVE_GRACE_MS) {
              console.log(`[ChatStore] Skipping load — save pending for ${conversationId.substring(0, 8)} (${elapsed}ms ago, grace ${PENDING_SAVE_GRACE_MS}ms)`);
              return;
            }
            // Grace period expired but flag wasn't cleared (save may have failed silently)
            pendingSaveTimestamps.delete(conversationId);
          }
        }

        // Skip if recently loaded (within cooldown) unless force=true (manual reload)
        if (!force && loadState?.lastLoadedAt) {
          const elapsed = Date.now() - loadState.lastLoadedAt;
          if (elapsed < MESSAGE_LOAD_COOLDOWN_MS) {
            console.log(`[ChatStore] Skipping reload for ${conversationId} (loaded ${elapsed}ms ago, cooldown ${MESSAGE_LOAD_COOLDOWN_MS}ms)`);
            return;
          }
        }

        messageLoadState.set(conversationId, { inFlight: true, lastLoadedAt: loadState?.lastLoadedAt ?? 0 });

        try {
          console.log(`[ChatStore] Loading messages from MongoDB for: ${conversationId}`);
          const response = await apiClient.getMessages(conversationId, { page_size: 100 });

          if (!response?.items || response.items.length === 0) {
            console.log('[ChatStore] No messages found in MongoDB for:', conversationId);
            return;
          }

          // Build an ordered list of raw items for look-ahead heuristics.
          // We need to know whether a "not final" assistant message is actually
          // followed by a subsequent user message — if so the response completed
          // successfully but the original session crashed before writing is_final=true.
          const rawItems = response.items;

          // Convert MongoDB messages to ChatMessage format
          const messages: ChatMessage[] = rawItems.map((msg, idx) => {
            // Deserialize stream events (for Dynamic Agents). Legacy records may
            // store them under `sse_events`.
            const streamEvents: StreamEvent[] = (msg.stream_events || msg.sse_events || []).map((e) => ({
              ...e,
              raw: e.raw ?? null,
              timestamp: new Date(e.timestamp),
            }));

            // Determine isFinal: prefer explicit metadata value.
            // We now always save is_final explicitly (false for in-progress, true for complete).
            // For legacy messages that don't have is_final, default to true (they were complete).
            let isFinal = msg.metadata?.is_final != null
              ? Boolean(msg.metadata.is_final)
              : true; // Legacy messages without is_final metadata are assumed complete

            // ── Stale is_final heal ──────────────────────────────────
            // If an assistant message has is_final=false but a subsequent user
            // message exists, the response DID complete — the original page just
            // crashed before persisting is_final=true.  Fix the flag so the
            // "Response was interrupted" banner does not show.
            if (msg.role === 'assistant' && !isFinal) {
              const hasFollowUp = rawItems.slice(idx + 1).some((message) => message.role === 'user');
              if (hasFollowUp) {
                console.log(`[ChatStore] Healing stale is_final=false for assistant message ${msg.message_id || msg._id} (followed by user message)`);
                isFinal = true;
              }
            }

            const isExplicitlyInterrupted = Boolean(msg.metadata?.is_interrupted);
            const hasHitlForm = streamEvents.some((event) => event.type === 'input_required');

            // Rehydrate user attachments from artifacts (type: "attachment").
            // Data may be absent for large files (dropped at persist time) — the
            // renderer falls back to a document chip in that case.
            const attachments = (msg.artifacts || [])
              .filter((a) => a.type === 'attachment')
              .map((a) => {
                const d = a.data as { mime_type?: string; size?: number; data?: string };
                return {
                  name: a.name,
                  mime_type: d?.mime_type || 'application/octet-stream',
                  ...(typeof d?.size === 'number' && { size: d.size }),
                  ...(typeof d?.data === 'string' && { data: d.data }),
                };
              });

            const chatMsg: ChatMessage = {
              id: msg.message_id || msg._id?.toString() || generateId(),
              role: msg.role as "user" | "assistant",
              content: msg.content,
              timestamp: new Date(msg.created_at),
              streamEvents: streamEvents.length > 0 ? streamEvents : undefined, // Only set if present
              isFinal,
              turnId: msg.metadata?.turn_id,
              taskId: msg.metadata?.task_id,
              // Restore turnStatus from MongoDB (defaults to undefined for legacy messages)
              turnStatus: msg.metadata?.turn_status as TurnStatus | undefined,
              // Mark as interrupted only if explicitly flagged in MongoDB, or
              // if this is the very last assistant message and it's not final
              // (genuinely mid-stream when saved, with no follow-up).
              // HITL messages are not interrupted — they're waiting for user input.
              isInterrupted: hasHitlForm ? false : (isExplicitlyInterrupted || (msg.role === 'assistant' && !isFinal)),
              feedback: msg.feedback ? {
                type: msg.feedback.rating === 'positive' ? 'like' : msg.feedback.rating === 'negative' ? 'dislike' : null,
                submitted: true,
              } : undefined,
              // Sender identity — present for messages created after this feature.
              // Legacy messages without these fields will fall back to session-based
              // display in the UI (backward compatible).
              senderEmail: msg.sender_email,
              senderName: msg.sender_name,
              senderImage: msg.sender_image,
              ...(attachments.length > 0 && { attachments }),
            };

            return chatMsg;
          });

          // Reconstruct streamEvents for the timeline / Tasks / Debug panels.
          // Only use events from the LAST assistant message (current/latest turn),
          // matching the live-streaming behavior where clearStreamEvents() is called
          // at the start of each new turn. This prevents completed tools from
          // old turns from accumulating in the Tasks panel.
          //
          // CRITICAL: If the conversation is currently streaming, do NOT overwrite
          // streamEvents — they were cleared at the start of the new turn and are
          // being populated from the live stream. Overwriting them with MongoDB
          // data would restore the PREVIOUS turn's events.
          const isCurrentlyStreaming = get().streamingConversations.has(conversationId);
          const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant');
          const lastTurnStreamEvents: StreamEvent[] = lastAssistantMsg?.streamEvents || [];

          const toolStartCount = lastTurnStreamEvents.filter((e: StreamEvent) => e.type === 'tool_start').length;
          const toolEndCount = lastTurnStreamEvents.filter((e: StreamEvent) => e.type === 'tool_end').length;
          console.log(`[Stream-DEBUG] loadMessagesFromServer: conv=${conversationId.substring(0, 8)}, msgs=${messages.length}, lastAssistant=${lastAssistantMsg?.id?.substring(0, 8) ?? 'NONE'}, lastTurnStreamEvents=${lastTurnStreamEvents.length} (${toolStartCount} tool_starts, ${toolEndCount} tool_ends), isStreaming=${isCurrentlyStreaming}`);

          if (isCurrentlyStreaming) {
            // Conversation is actively streaming — the in-memory Zustand state is the
            // live buffer being built by the stream. Don't overwrite it with stale MongoDB
            // data. Only merge stream events from MongoDB into local messages that lack them.
            console.log(`[Stream-DEBUG] ⚠️ loadMessagesFromServer: conversation is streaming — merging events only, preserving live messages`);

            const serverEventsByMsgId = new Map<string, StreamEvent[]>();
            for (const msg of messages) {
              if (msg.streamEvents && msg.streamEvents.length > 0) {
                serverEventsByMsgId.set(msg.id, msg.streamEvents);
              }
            }

            set((state: ChatState) => ({
              conversations: state.conversations.map((c: Conversation) =>
                c.id === conversationId
                  ? {
                      ...c,
                      // Don't overwrite conversation-level streamEvents during streaming
                      messages: c.messages.map((localMsg: ChatMessage) => {
                        const serverEvents = serverEventsByMsgId.get(localMsg.id);
                        if (serverEvents && (!localMsg.streamEvents || localMsg.streamEvents.length === 0)) {
                          return { ...localMsg, streamEvents: serverEvents };
                        }
                        return localMsg;
                      }),
                    }
                  : c
              ),
            }));
          } else {
            // Not streaming — MongoDB is the source of truth, but we must
            // guard against a race where periodic saves wrote stale intermediate
            // content.  If a local message is already marked isFinal=true but
            // MongoDB still has isFinal=false (periodic save hadn't been
            // overwritten by the final save yet), keep the local version to
            // prevent the UI from regressing to stale content.
            set((state: ChatState) => {
              const existingConv = state.conversations.find((c: Conversation) => c.id === conversationId);
              const localMsgMap = new Map<string, ChatMessage>();
              if (existingConv) {
                for (const m of existingConv.messages) {
                  localMsgMap.set(m.id, m);
                }
              }

              const mergedMessages = messages.map((serverMsg: ChatMessage) => {
                const localMsg = localMsgMap.get(serverMsg.id);
                // Preserve local final content when MongoDB still has non-final
                // (stale periodic-save data). Once MongoDB catches up (final save
                // completes), isFinal will be true on both sides and we'll use
                // the server version normally.
                if (localMsg?.isFinal && !serverMsg.isFinal) {
                  console.log(`[ChatStore] Preserving local final message ${serverMsg.id.substring(0, 8)} (MongoDB has stale non-final version)`);
                  return localMsg;
                }
                return serverMsg;
              });

              return {
                conversations: state.conversations.map((c: Conversation) =>
                  c.id === conversationId
                    ? {
                        ...c,
                        messages: mergedMessages,
                        streamEvents: lastTurnStreamEvents,
                      }
                    : c
                ),
              };
            });

            console.log(`[ChatStore] Loaded ${messages.length} messages with ${lastTurnStreamEvents.length} stream events from MongoDB for: ${conversationId}`);
          }

        } catch (error) {
          if (getErrorMessage(error, "")?.includes('401') || getErrorMessage(error, "")?.includes('Unauthorized')) {
            console.log('[ChatStore] Not authenticated, skipping message load');
          } else if (getErrorMessage(error, "")?.includes('404')) {
            console.log('[ChatStore] Conversation not found in MongoDB (normal for new conversations)');
          } else {
            console.error('[ChatStore] Failed to load messages from MongoDB:', error);
          }
        } finally {
          messageLoadState.set(conversationId, { inFlight: false, lastLoadedAt: Date.now() });
        }
      },

      // Evict content from old messages to free memory.
      // Replaces content with a short preview and clears rawStreamContent + stream events.
      // The full content can be re-loaded from MongoDB via loadMessagesFromServer.
      evictOldMessageContent: (conversationId: string, messageIdsToEvict: string[]) => {
        if (messageIdsToEvict.length === 0) return;
        const evictSet = new Set(messageIdsToEvict);
        let evictedCount = 0;
        let freedChars = 0;

        set((state: ChatState) => ({
          conversations: state.conversations.map((c: Conversation) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              messages: c.messages.map((msg: ChatMessage) => {
                if (!evictSet.has(msg.id)) return msg;
                // Keep a short preview for the collapsed banner, evict the rest
                const preview = msg.content.slice(0, 80);
                freedChars += (msg.content?.length || 0) + (msg.rawStreamContent?.length || 0);
                evictedCount++;
                return {
                  ...msg,
                  content: preview,
                  rawStreamContent: undefined,
                  streamEvents: undefined, // Clear events too — they're in MongoDB
                };
              }),
            };
          }),
        }));

        console.log(`[ChatStore] Evicted content from ${evictedCount} messages (~${(freedChars / 1024).toFixed(0)}KB freed) for: ${conversationId.substring(0, 8)}`);
      },

      markConversationUnviewed: (conversationId: string) => {
        set((prev: ChatState) => {
          const newSet = new Set(prev.unviewedConversations);
          newSet.add(conversationId);
          return { unviewedConversations: newSet };
        });
      },

      clearConversationUnviewed: (conversationId: string) => {
        set((prev: ChatState) => {
          const newSet = new Set(prev.unviewedConversations);
          newSet.delete(conversationId);
          return { unviewedConversations: newSet };
        });
      },

      hasUnviewedMessages: (conversationId: string) => {
        return get().unviewedConversations.has(conversationId);
      },

      markConversationInputRequired: (conversationId: string) => {
        set((prev: ChatState) => {
          const newSet = new Set(prev.inputRequiredConversations);
          newSet.add(conversationId);
          return { inputRequiredConversations: newSet };
        });
      },

      clearConversationInputRequired: (conversationId: string) => {
        set((prev: ChatState) => {
          const newSet = new Set(prev.inputRequiredConversations);
          newSet.delete(conversationId);
          return { inputRequiredConversations: newSet };
        });
      },

      isConversationInputRequired: (conversationId: string) => {
        return get().inputRequiredConversations.has(conversationId);
      },
});

// Export store with conditional persistence based on storage mode
export const useChatStore = shouldUseLocalStorage()
  ? // localStorage mode: Enable persistence
    create<ChatState>()(
      persist(storeImplementation, {
        name: "caipe-chat-history",
        storage: createJSONStorage(() => localStorage),
        partialize: (state) => ({
          conversations: state.conversations.map((conv) => ({
            ...conv,
            streamEvents: [], // Don't persist stream events (too large)
            messages: conv.messages.map((msg) => ({
              ...msg,
              streamEvents: undefined, // Don't persist per-message stream events
            })),
          })),
          activeConversationId: state.activeConversationId,
        }),
        onRehydrateStorage: () => (state) => {
          if (state) {
            state.conversations = state.conversations.map((conv) => ({
              ...conv,
              createdAt: new Date(conv.createdAt),
              updatedAt: new Date(conv.updatedAt),
              streamEvents: [],
              messages: conv.messages.map((msg, idx, allMsgs) => {
                // CRASH RECOVERY: Mark non-final assistant messages as interrupted.
                // After a page crash/reload, streamingConversations is empty (not persisted),
                // so any assistant message without isFinal=true was mid-stream when the tab died.
                //
                // HEAL: If a subsequent user message exists, the response actually completed
                // — the original session just didn't persist isFinal=true before crashing.
                let healed = false;
                if (msg.role === 'assistant' && !msg.isFinal) {
                  const hasFollowUp = allMsgs.slice(idx + 1).some(m => m.role === 'user');
                  if (hasFollowUp) healed = true;
                }
                return {
                  ...msg,
                  timestamp: new Date(msg.timestamp),
                  streamEvents: undefined,
                  isFinal: healed ? true : msg.isFinal,
                  isInterrupted: healed
                    ? false
                    : (msg.role === 'assistant' && !msg.isFinal ? true : msg.isInterrupted),
                };
              }),
            }));
          }
        },
      })
    )
  : // MongoDB mode: NO localStorage cache — MongoDB is the sole source of truth.
    // State lives in Zustand's in-memory store only (survives within a session via
    // React re-renders) and is loaded from / saved to MongoDB explicitly.
    // This eliminates the "two sources of truth" drift that caused stale content,
    // phantom "interrupted" banners, and merge conflicts between localStorage and MongoDB.
    create<ChatState>()(storeImplementation);

// ═══════════════════════════════════════════════════════════════
// DEBUG: Expose diagnostic helpers on window for debugging message persistence
// Run in browser console:   __caipeDebug.messages()        — local messages
//                           __caipeDebug.compare()         — local vs MongoDB diff
//                           __caipeDebug.mongo()           — raw MongoDB fetch
//                           __caipeDebug.localStorage()    — raw localStorage data
// ═══════════════════════════════════════════════════════════════
if (typeof window !== 'undefined') {
  window.__caipeDebug = {
    /** Show local messages for the active conversation */
    messages: () => {
      const state = useChatStore.getState();
      const conv = state.conversations.find((c: Conversation) => c.id === state.activeConversationId);
      if (!conv) { console.log('No active conversation'); return; }
      console.log(`Conversation: ${conv.id} (${conv.title || 'untitled'})`);
      console.log(`Messages: ${conv.messages.length}`);
      console.table(conv.messages.map((m: ChatMessage) => ({
        id: m.id?.substring(0, 8),
        role: m.role,
        contentLen: m.content?.length || 0,
        contentPreview: (m.content || '').substring(0, 80),
        isFinal: m.isFinal,
        isInterrupted: m.isInterrupted,
        taskId: m.taskId?.substring(0, 8),
        turnId: m.turnId?.substring(0, 8),
        streamEvents: m.streamEvents?.length || 0,
      })));
      return conv.messages;
    },
    /** Fetch messages from MongoDB for the active conversation and compare */
    compare: async () => {
      const state = useChatStore.getState();
      const convId = state.activeConversationId;
      if (!convId) { console.log('No active conversation'); return; }
      const conv = state.conversations.find((c: Conversation) => c.id === convId);
      const localMsgs = conv?.messages || [];

      try {
        const res = await fetch(`/api/chat/conversations/${convId}/messages?pageSize=100`);
        const data = await res.json();
        const mongoMsgs = data.items || data.data || [];

        console.log(`\n=== COMPARISON for ${convId} ===`);
        console.log(`Local: ${localMsgs.length} messages | MongoDB: ${mongoMsgs.length} messages`);

        const maxLen = Math.max(localMsgs.length, mongoMsgs.length);
        const rows = [];
        for (let i = 0; i < maxLen; i++) {
          const local = localMsgs[i] as ChatMessage | undefined;
          const mongo = mongoMsgs[i] as StoredMessage | undefined;
          rows.push({
            '#': i,
            localId: local?.id?.substring(0, 8) || '—',
            mongoId: (mongo?.message_id || mongo?._id?.toString())?.substring(0, 8) || '—',
            role: local?.role || mongo?.role || '—',
            localContentLen: local?.content?.length || 0,
            mongoContentLen: mongo?.content?.length || 0,
            contentMatch: local && mongo ? (local.content?.length === mongo.content?.length ? '✅' : `❌ Δ${(local.content?.length || 0) - (mongo.content?.length || 0)}`) : '—',
            localIsFinal: local?.isFinal,
            mongoIsFinal: mongo?.metadata?.is_final,
            finalMatch: local && mongo ? (Boolean(local.isFinal) === Boolean(mongo.metadata?.is_final) ? '✅' : '❌') : '—',
            localInterrupted: local?.isInterrupted,
            mongoInterrupted: mongo?.metadata?.is_interrupted,
            localEvents: local?.streamEvents?.length || 0,
            mongoEvents: mongo?.stream_events?.length || 0,
          });
        }
        console.table(rows);
        return { local: localMsgs, mongo: mongoMsgs, rows };
      } catch (err) {
        console.error('Failed to fetch from MongoDB:', err);
      }
    },
    /** Fetch raw MongoDB messages for active conversation */
    mongo: async () => {
      const convId = useChatStore.getState().activeConversationId;
      if (!convId) { console.log('No active conversation'); return; }
      const res = await fetch(`/api/chat/conversations/${convId}/messages?pageSize=100`);
      const data = await res.json();
      const items = (data.items || data.data || []) as StoredMessage[];
      console.log(`MongoDB: ${items.length} messages for ${convId}`);
      console.table(items.map((message) => ({
        id: (message.message_id || message._id?.toString())?.substring(0, 8),
        role: message.role,
        contentLen: message.content?.length || 0,
        contentPreview: (message.content || '').substring(0, 80),
        is_final: message.metadata?.is_final,
        is_interrupted: message.metadata?.is_interrupted,
        task_id: message.metadata?.task_id?.substring(0, 8),
        events: message.stream_events?.length || 0,
      })));
      return items;
    },
    /** Show raw localStorage cache data */
    localStorage: () => {
      for (const key of ['caipe-chat-history', 'caipe-chat-history-mongodb-cache']) {
        const raw = window.localStorage.getItem(key);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            const convs = (parsed?.state?.conversations || []) as DebugLocalConversation[];
            console.log(`\n=== ${key} ===`);
            console.log(`Conversations: ${convs.length}`);
            for (const conv of convs) {
              console.log(`  ${conv.id?.substring(0, 8)}: "${conv.title}" — ${conv.messages?.length || 0} messages`);
              if (conv.messages) {
                console.table(conv.messages.map((message) => ({
                  id: message.id?.substring(0, 8),
                  role: message.role,
                  contentLen: message.content?.length || 0,
                  isFinal: message.isFinal,
                  isInterrupted: message.isInterrupted,
                })));
              }
            }
          } catch { console.log(`${key}: parse error`); }
        } else {
          console.log(`${key}: not found`);
        }
      }
    },
    /** Show storage mode info */
    storageMode: () => {
      const mode = getStorageMode();
      console.log(`Storage mode: ${mode}`);
      if (mode === 'mongodb') {
        console.log('MongoDB is sole source of truth — no localStorage cache');
      } else {
        console.log('localStorage mode — data persisted in browser only');
      }
    },
  };
  console.log('[CAIPE] Debug helpers available: __caipeDebug.messages(), __caipeDebug.compare(), __caipeDebug.mongo(), __caipeDebug.localStorage(), __caipeDebug.storageMode()');

  // ── ONE-TIME CLEANUP: Remove stale localStorage cache from MongoDB mode ──
  // Previous versions used localStorage as a cache in MongoDB mode under the key
  // "caipe-chat-history-mongodb-cache". This created two-source-of-truth bugs.
  // Clear it on startup so users don't accidentally load stale cached data.
  if (getStorageMode() === 'mongodb') {
    const staleKey = 'caipe-chat-history-mongodb-cache';
    if (window.localStorage.getItem(staleKey)) {
      console.log(`[ChatStore] Removing stale localStorage cache: ${staleKey}`);
      window.localStorage.removeItem(staleKey);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// PERSISTENCE HARDENING: Save in-flight conversations on tab close / navigation
// ═══════════════════════════════════════════════════════════════
// Uses visibilitychange (recommended by Page Lifecycle API) as the primary handler,
// with beforeunload as a fallback. When the tab is hidden or the user navigates away,
// we save any conversations that were streaming to avoid data loss.
if (typeof window !== 'undefined') {
  const saveInflightConversations = () => {
    const state = useChatStore.getState();
    if (state.streamingConversations.size === 0) return;

    console.log(`[ChatStore] Tab hidden/closing — saving ${state.streamingConversations.size} in-flight conversation(s)`);
    for (const [conversationId] of state.streamingConversations) {
      // Reset periodic save counter
      eventCountSinceLastSave.delete(conversationId);
      // Fire-and-forget save (browser may kill the page before completion,
      // but periodic saves during streaming provide a safety net)
      state.saveMessagesToServer(conversationId).catch((error) => {
        console.error(`[ChatStore] Save on unload failed for ${conversationId}:`, error);
      });
    }
  };

  // Primary: visibilitychange fires reliably on tab close, navigation, app switch.
  // Browsers give ~5s of execution time for this handler.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveInflightConversations();
    }
  });

  // Fallback: beforeunload for older browsers and explicit tab close.
  // Also prompts the user to confirm if any conversations are actively streaming,
  // so they don't accidentally lose an in-flight response.
  window.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
    saveInflightConversations();

    const state = useChatStore.getState();
    if (state.streamingConversations.size > 0) {
      e.preventDefault();
      const count = state.streamingConversations.size;
      const msg =
        count === 1
          ? 'You have 1 live chat receiving a response. Refreshing will interrupt it.'
          : `You have ${count} live chats receiving responses. Refreshing will interrupt them.`;
      e.returnValue = msg;
    }
  });
}
