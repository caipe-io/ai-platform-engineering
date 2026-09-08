export const ADMIN_STATS_SECTIONS = [
  'overview',
  'filters',
  'activity',
  'top_users',
  'top_agents',
  'feedback',
  'response_time',
  'hourly_heatmap',
  'completed_workflows',
  'slack',
  'webex',
  'api',
] as const;

export type AdminStatsSection = typeof ADMIN_STATS_SECTIONS[number];

export type AdminStatsOwnerType = 'service_account' | 'slack_bot' | 'linked' | 'unlinked_slack';

export interface AdminStatsPagination {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

export interface AdminSlackStats {
  channels: {
    total: number;
    qanda_enabled: number;
    alerts_enabled: number;
    ai_enabled: number;
  };
  total_interactions: number;
  unique_users: number;
  configured_channels?: number;
  configured_channels_daily?: Array<{
    date: string;
    total: number;
  }>;
  daily: Array<{
    date: string;
    interactions: number;
    unique_users: number;
    escalated: number;
  }>;
  top_channels: Array<{
    channel_name: string;
    interactions: number;
  }>;
}

export interface AdminWebexStats {
  total_interactions: number;
  unique_users: number;
  configured_spaces?: number;
  configured_spaces_daily?: Array<{
    date: string;
    total: number;
  }>;
  daily: Array<{
    date: string;
    interactions: number;
    unique_users: number;
  }>;
  top_spaces: Array<{
    space_name: string;
    interactions: number;
  }>;
}

export interface AdminApiStats {
  total_interactions: number;
  unique_users: number;
  daily: Array<{
    date: string;
    interactions: number;
    unique_users: number;
  }>;
  // Direct MCP Activity — sourced from the audit-service (agent_gateway
  // OK_LOCAL_AGENT_CONTEXT events), not the conversations/messages Mongo
  // collections. Admin-only (see admin/stats/route.ts): omitted entirely for
  // a non-admin caller rather than returned empty, so a scoped view can never
  // reveal platform-wide MCP caller identities.
  mcp_activity?: {
    total_events: number;
    unique_users: number;
    daily: Array<{
      date: string;
      events: number;
      unique_users: number;
    }>;
    // True when the audit-service could not be reached/queried for this
    // request — the rest of the `api` section still renders normally.
    unavailable?: boolean;
    // True when the selected dashboard range exceeds the audit-service's
    // query cap and was clamped to its most recent 31 days.
    range_capped?: boolean;
  };
}

export interface AdminStats {
  platform_summary: {
    satisfaction_rate: number;
  };
  overview: {
    total_users: number;
    total_conversations: number;
    total_messages: number;
    shared_conversations: number;
    dau: number;
    mau: number;
    conversations_today: number;
    messages_today: number;
    avg_messages_per_conversation: number;
  };
  daily_activity: Array<{
    date: string;
    active_users: number;
    conversations: number;
    messages: number;
  }>;
  top_users: {
    by_conversations: Array<{
      _id: string;
      count: number;
      name?: string;
      owner_type?: AdminStatsOwnerType;
    }>;
    by_messages: Array<{
      _id: string;
      count: number;
      name?: string;
      owner_type?: AdminStatsOwnerType;
    }>;
    pagination?: {
      by_conversations: AdminStatsPagination;
      by_messages: AdminStatsPagination;
    };
  };
  top_agents: Array<{ _id: string; count: number }>;
  feedback_summary: {
    positive: number;
    negative: number;
    total: number;
    satisfaction_rate?: number;
    by_source?: Record<string, { positive: number; negative: number }>;
    categories?: Array<{ category: string; count: number }>;
    daily?: Array<{ date: string; positive: number; negative: number }>;
  };
  response_time: {
    avg_ms: number;
    min_ms: number;
    max_ms: number;
    sample_count: number;
    samples?: Array<{ ts: string; latency_ms: number }>;
  };
  hourly_heatmap: Array<{ hour: number; count: number }>;
  completed_workflows: {
    total: number;
    today: number;
    failed: number;
    completion_rate: number;
    avg_steps_per_workflow: number;
  };
  slack: AdminSlackStats;
  webex: AdminWebexStats;
  api: AdminApiStats;
  available_channels: string[];
  available_agents: Array<{ id: string; name: string }>;
}

export type AdminStatsData = Partial<AdminStats>;
