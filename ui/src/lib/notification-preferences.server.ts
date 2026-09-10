import { getCollection } from "@/lib/mongodb";
import type { UserSettings } from "@/types/mongodb";

export async function platformHealthNotificationsEnabled(
  userEmail: string,
): Promise<boolean> {
  const normalizedEmail = userEmail.trim();
  if (!normalizedEmail) return true;

  const settings = await getCollection<UserSettings>("user_settings");
  const userSettings = await settings.findOne({ user_id: normalizedEmail });
  return userSettings?.notifications?.platform_health !== false;
}
