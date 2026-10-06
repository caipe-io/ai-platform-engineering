"use client";

import { AuthGuard } from "@/components/auth-guard";
import { CAIPESpinner } from "@/components/ui/caipe-spinner";
import { resolveUsableChatAgentId } from "@/lib/chat-agent-selection";
import { getStorageMode } from "@/lib/storage-config";
import { getLastActiveConversationId,useChatStore } from "@/store/chat-store";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect,useRef,useState } from "react";

/**
 * /chat landing page — resumes the last active conversation, falls back to
 * the most recent one, or creates a new conversation.
 *
 * Priority order:
 *  1. activeConversationId from the store (remembers the user's last selection
 *     across tab switches — e.g. Chat → Skills → Chat), only if owned.
 *  2. The most recent OWNED conversation (first visit / active was deleted).
 *  3. Create a brand-new conversation (empty history).
 *
 * Only conversations owned by the current user are considered for auto-redirect.
 * Shared conversations are excluded to prevent cross-user runtime context
 * collisions — the conversations API returns owned + shared entries in a
 * single list, and auto-selecting a shared conversation would cause multiple
 * users to unknowingly share the same backend context.
 */
function ChatRedirectPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const redirected = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const createConversation = useChatStore((s) => s.createConversation);
  const loadConversationsFromServer = useChatStore((s) => s.loadConversationsFromServer);

  useEffect(() => {
    if (status === "loading") return;
    if (redirected.current) return;
    redirected.current = true;

    const resolve = async () => {
      const storageMode = getStorageMode();

      // In MongoDB mode, ensure conversations are loaded from the server first
      if (storageMode === "mongodb") {
        await loadConversationsFromServer();
      }

      // Re-read from the store after potential server load
      const state = useChatStore.getState();
      const { conversations: currentConversations, activeConversationId } = state;
      const lastActiveConversationId = activeConversationId ?? getLastActiveConversationId();
      const userEmail = session?.user?.email;

      // Only consider conversations OWNED by the current user for auto-redirect.
      // The API returns shared conversations in the same list; picking one
      // of those would silently drop the user into someone else's conversation,
      // causing all their messages to share the same backend context.
      // In localStorage mode, owner_id is unset — include those conversations.
      const ownedConversations = userEmail
        ? currentConversations.filter((c) => !c.owner_id || c.owner_id === userEmail)
        : currentConversations;

      // 1. Resume the last active conversation when it still exists in the loaded list.
      // Prefer owned entries for auto-pick below, but an explicit last-active id from
      // this browser should win to avoid spawning duplicate empty chats on /chat.
      if (lastActiveConversationId) {
        const stillExists = currentConversations.some((c) => c.id === lastActiveConversationId);
        if (stillExists) {
          router.replace(`/chat/${lastActiveConversationId}`);
          return;
        }
      }

      // 2. Fall back to the most recent OWNED conversation (sorted by updatedAt)
      if (ownedConversations.length > 0) {
        const latestId = ownedConversations[0].id;
        router.replace(`/chat/${latestId}`);
      } else {
        // 3. No owned conversations — create a new one
        const newId = await createConversation(await resolveUsableChatAgentId());
        router.replace(`/chat/${newId}`);
      }
    };

    resolve().catch((error) => {
      console.error("[ChatRedirect] Failed to resolve conversation:", error);
      setError(error instanceof Error ? error.message : "Failed to resolve a chat agent");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center h-full bg-background p-6">
        <div className="max-w-md rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center h-full bg-background">
      <CAIPESpinner size="lg" message="Loading conversations..." />
    </div>
  );
}

export default function Chat() {
  return (
    <AuthGuard>
      <ChatRedirectPage />
    </AuthGuard>
  );
}
