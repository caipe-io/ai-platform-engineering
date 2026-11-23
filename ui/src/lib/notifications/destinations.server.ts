import { getRealmUserById } from "@/lib/rbac/keycloak-admin";

export async function linkedNotificationAccounts(
  subject: string,
): Promise<{ slack: string | null; webex: string | null }> {
  const user = await getRealmUserById(subject);
  if (user.enabled === false) return { slack: null, webex: null };
  const attributes = user.attributes as Record<string, string[]> | undefined;
  return {
    slack: attributes?.slack_user_id?.[0]?.trim() || null,
    webex: attributes?.webex_user_id?.[0]?.trim() || null,
  };
}
