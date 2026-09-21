// Client-side API SDK for calling MongoDB backend APIs

import type {
AddMessageRequest,
ApiResponse,
ClientType,
Conversation,
ConversationBookmark,
CreateBookmarkRequest,
CreateConversationRequest,
CreateConversationResponse,
Message,
PaginatedResponse,
ShareConversationRequest,
Turn,
UpdateConversationRequest,
UpdateMessageRequest,
UpdateSettingsRequest,
UpdateUserRequest,
UpsertTurnRequest,
User,
UserPublicInfo,
UserSettings,
UserStats,
} from '@/types/mongodb';
import type { AuthFailureAction,AuthFailureReason } from "./auth-error";

/**
 * Thrown by {@link APIClient.request} for any non-OK response. Carries the
 * HTTP status plus the Web UI backend's structured auth-error fields (`code`, `reason`,
 * `action`) when present, so callers (chat panel, dynamic-agent editor, etc.)
 * can distinguish auth failures from backend errors and render an
 * appropriate toast (see `lib/auth-error.ts`).
 */
export class APIClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public reason?: AuthFailureReason,
    public action?: AuthFailureAction,
  ) {
    super(message);
    this.name = "APIClientError";
  }
}

class APIClient {
  private baseURL: string;

  constructor(baseURL: string = '') {
    this.baseURL = baseURL;
  }

  private async request<T>(
    endpoint: string,
    options?: RequestInit
  ): Promise<T> {
    const url = `${this.baseURL}${endpoint}`;
    console.log(`[APIClient] Making request to: ${url}`);
    
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Source': 'caipe-ui',
        ...options?.headers,
      },
    });

    console.log(`[APIClient] Response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorText = await response.text();
      
      // Don't log certain expected errors as console errors
      if (response.status === 401) {
        // 401: Authentication required - expected when auth is not configured
        console.log(`[APIClient] Authentication required for ${endpoint} - user not logged in`);
      } else if (response.status === 404) {
        // 404: Resource not found - this is expected in many cases:
        // - New conversations not yet saved to MongoDB
        // - Deleted conversations
        // - Conversations being navigated away from
        console.log(`[APIClient] Resource not found: ${endpoint}`);
      } else {
        // Log other errors
        console.error(`[APIClient] Error response:`, {
          status: response.status,
          statusText: response.statusText,
          body: errorText
        });
      }
      
      // Parse structured Web UI backend error body. Preserves {code, reason, action}
      // for callers (auth-error.ts consumers) so they can branch on stable
      // machine-readable codes instead of substring-matching English.
      let parsed: {
        error?: string;
        code?: string;
        reason?: AuthFailureReason;
        action?: AuthFailureAction;
      } = {};
      try {
        parsed = JSON.parse(errorText) as typeof parsed;
      } catch {
        parsed = { error: response.statusText || errorText };
      }
      throw new APIClientError(
        parsed.error || `HTTP ${response.status}`,
        response.status,
        parsed.code,
        parsed.reason,
        parsed.action,
      );
    }

    const responseText = await response.text();
    console.log(`[APIClient] Response body:`, responseText.substring(0, 500));
    
    let result: ApiResponse<T>;
    try {
      result = JSON.parse(responseText);
    } catch (parseError) {
      console.error(`[APIClient] Failed to parse JSON:`, {
        error: parseError,
        responseText: responseText.substring(0, 500)
      });
      throw new Error('Invalid JSON response from server');
    }

    console.log(`[APIClient] Parsed result:`, {
      success: result.success,
      hasData: !!result.data,
      dataType: typeof result.data,
      error: result.error
    });

    if (!result.success) {
      throw new Error(result.error || 'Request failed');
    }

    if (result.data === undefined || result.data === null) {
      console.error(`[APIClient] Result data is undefined/null:`, {
        result,
        success: result.success,
        error: result.error,
        hasData: result.data !== undefined,
        dataValue: result.data
      });
      throw new Error(result.error || 'Response data is undefined');
    }

    console.log(`[APIClient] Returning data:`, {
      dataType: typeof result.data,
      isArray: Array.isArray(result.data),
      keys: result.data ? Object.keys(result.data) : [],
      preview: JSON.stringify(result.data).substring(0, 200)
    });

    return result.data as T;
  }

  // ========================================================================
  // Conversations
  // ========================================================================

  async getConversations(params?: {
    page?: number;
    page_size?: number;
    archived?: boolean;
    pinned?: boolean;
    /**
     * Filter by conversation origin. The API only honors an allow-list of
     * values ('autonomous' | 'web'); any other value is ignored server-side
     * and the default human view is returned. Used by the sidebar's
     * "Autonomous only" filter chip to surface autonomous_agents runs.
     */
    source?: 'autonomous' | 'web';
    client_type?: ClientType;
  }): Promise<PaginatedResponse<Conversation>> {
    const searchParams = new URLSearchParams();
    if (params?.page) searchParams.set('page', params.page.toString());
    if (params?.page_size) searchParams.set('page_size', params.page_size.toString());
    if (params?.archived !== undefined) searchParams.set('archived', params.archived.toString());
    if (params?.pinned !== undefined) searchParams.set('pinned', params.pinned.toString());
    if (params?.source) searchParams.set('source', params.source);
    // Default to webui conversations only — excludes Slack/other client conversations.
    // Use `??` so an explicit empty string from the caller is preserved (vs `||` which would
    // overwrite it with the default).
    searchParams.set('client_type', params?.client_type ?? 'webui');

    return this.request(`/api/chat/conversations?${searchParams}`);
  }

  async createConversation(
    data: CreateConversationRequest
  ): Promise<CreateConversationResponse> {
    return this.request('/api/chat/conversations', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getConversation(id: string): Promise<Conversation> {
    return this.request(`/api/chat/conversations/${id}`);
  }

  async updateConversation(
    id: string,
    data: UpdateConversationRequest
  ): Promise<Conversation> {
    return this.request(`/api/chat/conversations/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteConversation(id: string): Promise<{ deleted: boolean; permanent: boolean }> {
    return this.request(`/api/chat/conversations/${id}`, {
      method: 'DELETE',
    });
  }

  async permanentDeleteConversation(id: string): Promise<{ deleted: boolean; permanent: boolean }> {
    return this.request(`/api/chat/conversations/${id}?permanent=true`, {
      method: 'DELETE',
    });
  }

  async restoreConversation(id: string): Promise<Conversation> {
    return this.request(`/api/chat/conversations/${id}/restore`, {
      method: 'POST',
    });
  }

  async getTrash(params?: { page_size?: number }): Promise<PaginatedResponse<Conversation>> {
    const searchParams = new URLSearchParams();
    if (params?.page_size) searchParams.set('page_size', params.page_size.toString());
    const query = searchParams.toString();
    return this.request(`/api/chat/conversations/trash${query ? `?${query}` : ''}`);
  }

  async archiveConversation(id: string): Promise<Conversation> {
    return this.request(`/api/chat/conversations/${id}/archive`, {
      method: 'POST',
    });
  }

  async pinConversation(id: string): Promise<Conversation> {
    return this.request(`/api/chat/conversations/${id}/pin`, {
      method: 'POST',
    });
  }

  // ========================================================================
  // Messages
  // ========================================================================

  async getMessages(
    conversationId: string,
    params?: { page?: number; page_size?: number }
  ): Promise<PaginatedResponse<Message>> {
    const searchParams = new URLSearchParams();
    if (params?.page) searchParams.set('page', params.page.toString());
    if (params?.page_size) searchParams.set('page_size', params.page_size.toString());

    return this.request(
      `/api/chat/conversations/${conversationId}/messages?${searchParams}`
    );
  }

  async addMessage(
    conversationId: string,
    data: AddMessageRequest
  ): Promise<Message> {
    return this.request(`/api/chat/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateMessage(
    messageId: string,
    data: UpdateMessageRequest
  ): Promise<Message> {
    return this.request(`/api/chat/messages/${messageId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // ========================================================================
  // Turns (per-turn persistence, decoupled from messages)
  // ========================================================================

  async getTurns(
    conversationId: string,
    params?: { client_type?: string; page?: number; page_size?: number }
  ): Promise<PaginatedResponse<Turn>> {
    const searchParams = new URLSearchParams();
    searchParams.set('client_type', params?.client_type || 'ui');
    if (params?.page) searchParams.set('page', params.page.toString());
    if (params?.page_size) searchParams.set('page_size', params.page_size.toString());

    return this.request(
      `/api/chat/conversations/${conversationId}/turns?${searchParams}`
    );
  }

  async upsertTurn(
    conversationId: string,
    data: UpsertTurnRequest,
  ): Promise<Turn> {
    return this.request(`/api/chat/conversations/${conversationId}/turns`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // ========================================================================
  // Sharing
  // ========================================================================

  async shareConversation(
    conversationId: string,
    data: ShareConversationRequest
  ): Promise<Conversation> {
    return this.request(`/api/chat/conversations/${conversationId}/share`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getSharedConversations(params?: {
    page?: number;
    page_size?: number;
  }): Promise<PaginatedResponse<Conversation>> {
    const searchParams = new URLSearchParams();
    if (params?.page) searchParams.set('page', params.page.toString());
    if (params?.page_size) searchParams.set('page_size', params.page_size.toString());

    return this.request(`/api/chat/shared?${searchParams}`);
  }

  // ========================================================================
  // Bookmarks
  // ========================================================================

  async getBookmarks(params?: {
    page?: number;
    page_size?: number;
  }): Promise<PaginatedResponse<ConversationBookmark>> {
    const searchParams = new URLSearchParams();
    if (params?.page) searchParams.set('page', params.page.toString());
    if (params?.page_size) searchParams.set('page_size', params.page_size.toString());

    return this.request(`/api/chat/bookmarks?${searchParams}`);
  }

  async createBookmark(data: CreateBookmarkRequest): Promise<ConversationBookmark> {
    return this.request('/api/chat/bookmarks', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // ========================================================================
  // Search
  // ========================================================================

  async searchConversations(params: {
    q?: string;
    tags?: string[];
    page?: number;
    page_size?: number;
  }): Promise<PaginatedResponse<Conversation>> {
    const searchParams = new URLSearchParams();
    if (params.q) searchParams.set('q', params.q);
    if (params.tags?.length) searchParams.set('tags', params.tags.join(','));
    if (params.page) searchParams.set('page', params.page.toString());
    if (params.page_size) searchParams.set('page_size', params.page_size.toString());

    return this.request(`/api/chat/search?${searchParams}`);
  }

  // ========================================================================
  // Users
  // ========================================================================

  async getCurrentUser(): Promise<User> {
    return this.request('/api/users/me');
  }

  async updateCurrentUser(data: UpdateUserRequest): Promise<User> {
    return this.request('/api/users/me', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async searchUsers(query: string): Promise<UserPublicInfo[]> {
    const searchParams = new URLSearchParams({ q: query });
    return this.request(`/api/users/search?${searchParams}`);
  }

  async getUserStats(): Promise<UserStats> {
    return this.request('/api/users/me/stats');
  }

  // ========================================================================
  // Settings
  // ========================================================================

  async getSettings(): Promise<UserSettings> {
    return this.request('/api/settings');
  }

  async updateSettings(data: UpdateSettingsRequest): Promise<UserSettings> {
    return this.request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async updatePreferences(
    preferences: Partial<UserSettings['preferences']>
  ): Promise<UserSettings> {
    return this.request('/api/settings/preferences', {
      method: 'PATCH',
      body: JSON.stringify(preferences),
    });
  }

  async updateNotifications(
    notifications: Partial<UserSettings['notifications']>
  ): Promise<UserSettings> {
    return this.request('/api/settings/notifications', {
      method: 'PATCH',
      body: JSON.stringify(notifications),
    });
  }

  async updateDefaults(
    defaults: Partial<UserSettings['defaults']>
  ): Promise<UserSettings> {
    return this.request('/api/settings/defaults', {
      method: 'PATCH',
      body: JSON.stringify(defaults),
    });
  }
}

// Export singleton instance
export const apiClient = new APIClient();
