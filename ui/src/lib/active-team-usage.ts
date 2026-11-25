import type { Document } from "mongodb";

import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { hashSubject } from "@/lib/rbac/audit";
import { listRealmUsersPage } from "@/lib/rbac/keycloak-admin";

const ACTIVE_USERS_COLLECTION = "app_usage_active_users_daily";
const DAY_MS = 86_400_000;
const RETENTION_DAYS = 30;
const KEYCLOAK_PAGE_SIZE = 100;

interface DailyActiveUser extends Document {
  date: string;
  subject_hash: string;
  expires_at: Date;
}

export interface ActiveTeamUsage {
  enabled: boolean;
  retention_days: number;
  daily: Array<{ date: string; active_users: number; active_teams: number }>;
  by_team: Array<{ team_label: string; active_users: number; active_days: number }>;
}

function attributeString(attributes: unknown, key: string): string {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return "";
  const value = (attributes as Record<string, unknown>)[key];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.trim() : "";
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Aggregate daily shell visits by the current Keycloak team_label. */
export async function readActiveTeamUsage(
  days = RETENTION_DAYS,
  now = new Date(),
): Promise<ActiveTeamUsage> {
  const enabled = process.env.APP_USAGE_ENABLED === "true";
  const result: ActiveTeamUsage = {
    enabled,
    retention_days: RETENTION_DAYS,
    daily: [],
    by_team: [],
  };
  if (!enabled || !isMongoDBConfigured) return result;

  const boundedDays = Math.max(1, Math.min(RETENTION_DAYS, Math.floor(days)));
  const endDay = utcDay(now);
  const start = new Date(Date.parse(`${endDay}T00:00:00.000Z`) - (boundedDays - 1) * DAY_MS);
  const startDay = utcDay(start);

  const usersByHash = new Map<string, string>();
  for (let first = 0; ; first += KEYCLOAK_PAGE_SIZE) {
    const users = await listRealmUsersPage(first, KEYCLOAK_PAGE_SIZE);
    for (const user of users) {
      if (user.enabled === false) continue;
      const id = typeof user.id === "string" ? user.id.trim() : "";
      const label = attributeString(user.attributes, "team_label");
      if (id && label) usersByHash.set(hashSubject(id), label);
    }
    if (users.length < KEYCLOAK_PAGE_SIZE) break;
  }

  const collection = await getCollection<DailyActiveUser>(ACTIVE_USERS_COLLECTION);
  const rows = await collection.find({
    date: { $gte: startDay, $lte: endDay },
    expires_at: { $gt: now },
  }, {
    projection: { _id: 0, date: 1, subject_hash: 1 },
    maxTimeMS: 10_000,
  }).toArray();

  const dailyUsers = new Map<string, Set<string>>();
  const dailyTeams = new Map<string, Map<string, Set<string>>>();
  for (let offset = 0; offset < boundedDays; offset += 1) {
    const date = utcDay(new Date(start.getTime() + offset * DAY_MS));
    dailyUsers.set(date, new Set());
    dailyTeams.set(date, new Map());
  }

  const teamUsers = new Map<string, Set<string>>();
  const teamDays = new Map<string, Set<string>>();
  for (const row of rows) {
    const team = usersByHash.get(row.subject_hash);
    if (!team || !dailyUsers.has(row.date)) continue;
    dailyUsers.get(row.date)?.add(row.subject_hash);
    const dayTeams = dailyTeams.get(row.date);
    if (!dayTeams) continue;
    const dayUsers = dayTeams.get(team) ?? new Set<string>();
    dayUsers.add(row.subject_hash);
    dayTeams.set(team, dayUsers);
    const allUsers = teamUsers.get(team) ?? new Set<string>();
    allUsers.add(row.subject_hash);
    teamUsers.set(team, allUsers);
    const activeDays = teamDays.get(team) ?? new Set<string>();
    activeDays.add(row.date);
    teamDays.set(team, activeDays);
  }

  result.daily = [...dailyUsers.entries()].map(([date, users]) => ({
    date,
    active_users: users.size,
    active_teams: dailyTeams.get(date)?.size ?? 0,
  }));
  result.by_team = [...teamUsers.entries()]
    .map(([team_label, users]) => ({
      team_label,
      active_users: users.size,
      active_days: teamDays.get(team_label)?.size ?? 0,
    }))
    .sort((a, b) => b.active_users - a.active_users || a.team_label.localeCompare(b.team_label));
  return result;
}
