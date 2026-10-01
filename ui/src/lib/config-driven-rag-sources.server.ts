import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { triggerIngestion } from "@/lib/rag-source-ingestion.server";
import { getAdminToken } from "@/lib/rbac/keycloak-admin";
import type { IngestionSourceConfig } from "@/types/ingestion-source";

const RECONCILE_INTERVAL_MS = 60_000;
const STALE_CLAIM_MS = 5 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function reconcileConfigDrivenRagSources(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const collection = await getCollection<IngestionSourceConfig>(
      "rag_ingestion_sources",
    );
    const staleClaimBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
    const candidates = await collection
      .find({
        config_driven: true,
        config_import_adopted: { $ne: true },
        $or: [
          { status: "pending" },
          {
            status: "failed",
            ingestion_job_id: { $exists: false },
          },
          {
            status: "ingesting",
            config_seed_claimed_at: { $lt: staleClaimBefore },
          },
        ],
      } as never)
      .limit(100)
      .toArray();
    if (candidates.length === 0) return;

    const accessToken = await getAdminToken();
    for (const candidate of candidates) {
      const claimedAt = new Date().toISOString();
      const claimed = await collection.findOneAndUpdate(
        {
          source_id: candidate.source_id,
          config_driven: true,
          config_import_adopted: { $ne: true },
          status: candidate.status,
          ...(candidate.config_seed_claimed_at
            ? { config_seed_claimed_at: candidate.config_seed_claimed_at }
            : { config_seed_claimed_at: { $exists: false } }),
        } as never,
        {
          $set: {
            status: "ingesting",
            config_seed_claimed_at: claimedAt,
            updated_at: claimedAt,
          },
        } as never,
        { returnDocument: "after" },
      );
      if (!claimed) continue;

      try {
        const trigger = await triggerIngestion(
          claimed,
          accessToken,
          claimed.owner_team_slug?.trim() || null,
        );
        await collection.updateOne(
          {
            source_id: claimed.source_id,
            config_seed_claimed_at: claimedAt,
          } as never,
          {
            $set: {
              status: "ingesting",
              ingestion_job_id: trigger.job_id,
              updated_at: new Date().toISOString(),
            },
            $unset: { config_seed_claimed_at: "", last_error: "" },
          } as never,
        );
        console.log(
          `[seed-config] Started ingestion for rag source: ${claimed.source_id}`,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to start ingestion";
        await collection.updateOne(
          {
            source_id: claimed.source_id,
            config_seed_claimed_at: claimedAt,
          } as never,
          {
            $set: {
              status: "failed",
              last_error: message.slice(0, 2000),
              updated_at: new Date().toISOString(),
            },
            $unset: { config_seed_claimed_at: "" },
          } as never,
        );
        console.warn(
          `[seed-config] Ingestion for rag source ${claimed.source_id} will retry:`,
          error,
        );
      }
    }
  } catch (error) {
    console.warn("[seed-config] RAG source ingestion reconcile failed:", error);
  } finally {
    running = false;
  }
}

export function startConfigDrivenRagSourceReconciler(): void {
  if (timer || !isMongoDBConfigured) return;
  void reconcileConfigDrivenRagSources();
  timer = setInterval(
    () => void reconcileConfigDrivenRagSources(),
    RECONCILE_INTERVAL_MS,
  );
  timer.unref?.();
}
