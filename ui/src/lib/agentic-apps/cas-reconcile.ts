import { reconcileTupleDiff } from "@/lib/authz/reconcile";
import { isAgenticAppsEnabled, loadConfiguredAgenticApps } from "./config";
import { readOpenFgaTuples, type OpenFgaTupleKey, type TeamResourceTupleDiff } from "@/lib/rbac/openfga";
import { organizationObjectId } from "@/lib/rbac/organization";
import type { ConfiguredAgenticApp } from "@/types/agentic-app";

const keyOf = (tuple: OpenFgaTupleKey) => JSON.stringify([tuple.user, tuple.relation, tuple.object]);
const isCatalogOwned = (tuple: OpenFgaTupleKey) => tuple.object.startsWith("agentic_app:") && (
  (tuple.user === "user:*" && tuple.relation === "user") ||
  (tuple.user === organizationObjectId() && tuple.relation === "catalog_managed") ||
  (tuple.user === organizationObjectId() + "#admin" && tuple.relation === "manager")
);

/** Ownership markers keep cleanup away from independently managed app grants. */
export function buildConfiguredAgenticAppCasTupleDiff(
  apps: readonly ConfiguredAgenticApp[], existing: readonly OpenFgaTupleKey[] = [],
): TeamResourceTupleDiff {
  const desired = apps.filter((app) => app.manifest.authorization && app.installation.installed &&
    app.installation.enabled && app.installation.visible).flatMap((app) => [
      { user: "user:*", relation: "user", object: "agentic_app:" + app.installation.appId },
      { user: organizationObjectId() + "#admin", relation: "manager", object: "agentic_app:" + app.installation.appId },
      { user: organizationObjectId(), relation: "catalog_managed", object: "agentic_app:" + app.installation.appId },
    ]);
  const desiredKeys = new Set(desired.map(keyOf));
  const managedObjects = new Set(existing.filter((tuple) => tuple.relation === "catalog_managed" &&
    tuple.user === organizationObjectId()).map((tuple) => tuple.object));
  return {
    writes: desired,
    deletes: existing.filter((tuple) => managedObjects.has(tuple.object) && isCatalogOwned(tuple) && !desiredKeys.has(keyOf(tuple))),
  };
}

let lastSuccess: { signature: string; at: number } | undefined;
let inFlight: Promise<void> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

/** Serialized, retryable reconciliation also gates requests until grants exist. */
export async function reconcileConfiguredAgenticAppCasAccess(
  apps = loadConfiguredAgenticApps(),
): Promise<void> {
  if (!isAgenticAppsEnabled() || process.env.AGENTIC_APPS_CAS_MODE === "off") return;
  const signature = JSON.stringify(apps);
  while (inFlight) await inFlight;
  if (lastSuccess?.signature === signature && Date.now() - lastSuccess.at < 30_000) return;
  const work = async () => {
    const existing: OpenFgaTupleKey[] = [];
    // Read persistent ownership markers, including removed app IDs. The scan is
    // bounded; an incomplete inventory never triggers partial revocations.
    for (const tuple of [
      { user: organizationObjectId(), relation: "catalog_managed", object: "agentic_app:" },
    ]) {
      let continuationToken: string | undefined;
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const page = await readOpenFgaTuples({ tuple, continuationToken, pageSize: 100 });
        existing.push(...page.tuples.flatMap(({ key }) => [key,
          { user: "user:*", relation: "user", object: key.object },
          { user: organizationObjectId() + "#admin", relation: "manager", object: key.object },
        ]));
        continuationToken = page.continuationToken;
        if (!continuationToken) break;
      }
      if (continuationToken) throw new Error("Configured app tuple inventory exceeds reconciliation limit");
    }
    await reconcileTupleDiff(buildConfiguredAgenticAppCasTupleDiff(apps, existing), {
      source: "external_apps_configured_access",
    });
    lastSuccess = { signature, at: Date.now() };
  };
  inFlight = work();
  try { await inFlight; } finally { inFlight = undefined; }
}

export function startConfiguredAgenticAppCasReconciler(): void {
  if (timer || !isAgenticAppsEnabled()) return;
  const tick = () => void reconcileConfiguredAgenticAppCasAccess().catch(() => {
    console.error("[external-apps/cas] Reconciliation unavailable; protected app requests remain fail-closed and reconciliation will retry");
  });
  tick();
  timer = setInterval(tick, 30_000);
  timer.unref?.();
}
