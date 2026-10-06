/** Admin → Integrations → Slack → Advanced → "Forward Platform Admin Notifications". */
export interface AdminNotificationForwardingConfig {
  enabled: boolean;
  channel_id: string | null;
  /** Display-only cache of the channel name; never used for delivery. */
  channel_name: string | null;
  /** Slack user (`U…`/`W…`) or user-group (`S…`) ids to @-mention. */
  ping_user_ids: string[];
}
