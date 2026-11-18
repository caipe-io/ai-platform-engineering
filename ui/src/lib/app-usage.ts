import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";

const COLLECTION = "app_usage_daily";
const DAY_MS = 86_400_000;
export const APP_USAGE_RETENTION_DAYS = 30;
let ttlIndexReady: Promise<string> | undefined;

interface DailyUsage {
  _id: string;
  loads: number;
  expires_at: Date;
}

export interface AppUsageSummary {
  enabled: boolean;
  retention_days: number;
  total_loads: number;
  daily: Array<{ date: string; loads: number }>;
}

function enabled(): boolean {
  return process.env.APP_USAGE_ENABLED === "true";
}

/** One daily counter, not user/session/URL tracking or a unique-visitor count. */
export async function recordAppVisit(occurredAt = new Date()): Promise<void> {
  if (!enabled() || !isMongoDBConfigured || !Number.isFinite(occurredAt.getTime())) return;
  const day = occurredAt.toISOString().slice(0, 10);
  const collection = await getCollection<DailyUsage>(COLLECTION);
  // Do not collect when retention cannot be installed. Failed initialization
  // remains retryable; no unbounded event history is retained as a fallback.
  ttlIndexReady ??= collection.createIndex({ expires_at: 1 }, {
    name: "app_usage_daily_expiry", expireAfterSeconds: 0,
  }).catch((error: unknown) => {
    ttlIndexReady = undefined;
    throw error;
  });
  await ttlIndexReady;
  const increment = { $inc: { loads: 1 } };
  try {
    await collection.updateOne({ _id: day }, {
      ...increment,
      $setOnInsert: { expires_at: new Date(Date.parse(day) + APP_USAGE_RETENTION_DAYS * DAY_MS) },
    }, { upsert: true });
  } catch (error) {
    // Concurrent first writes can race on the unique day key. The failed
    // insert did not increment; retry just that increment on the existing row.
    if ((error as { code?: number })?.code !== 11000) throw error;
    const result = await collection.updateOne({ _id: day }, increment);
    if (result.matchedCount !== 1) throw error;
  }
}

export async function readAppUsage(now = new Date()): Promise<AppUsageSummary> {
  const summary: AppUsageSummary = {
    enabled: enabled(), retention_days: APP_USAGE_RETENTION_DAYS, total_loads: 0, daily: [],
  };
  if (!summary.enabled) return summary;
  const collection = await getCollection<DailyUsage>(COLLECTION);
  const today = now.toISOString().slice(0, 10);
  const first = new Date(Date.parse(today) - (APP_USAGE_RETENTION_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const rows = await collection.find({
    _id: { $gte: first, $lte: today }, expires_at: { $gt: now },
  }).sort({ _id: 1 }).limit(APP_USAGE_RETENTION_DAYS).toArray();
  summary.daily = rows.map((row) => ({ date: row._id, loads: row.loads }));
  summary.total_loads = summary.daily.reduce((total, row) => total + row.loads, 0);
  return summary;
}
