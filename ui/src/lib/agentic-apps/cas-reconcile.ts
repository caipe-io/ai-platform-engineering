import { reconcileTupleDiff } from "@/lib/authz/reconcile";
import { loadConfiguredAgenticApps } from "@/lib/agentic-apps/config";
import type { TeamResourceTupleDiff } from "@/lib/rbac/openfga";
import { organizationObjectId } from "@/lib/rbac/organization";
import type { ConfiguredAgenticApp } from "@/types/agentic-app";

export function buildConfiguredAgenticAppCasTupleDiff(
  apps: readonly ConfiguredAgenticApp[],
): TeamResourceTupleDiff {
  const writes: TeamResourceTupleDiff["writes"] = [];
  const deletes: TeamResourceTupleDiff["deletes"] = [];

  for (const app of apps) {
    if (!app.manifest.authorization) continue;
    const appId = app.installation.appId;
    const tuples = [
      { user: "user:*", relation: "user", object: `agentic_app:${appId}` },
      {
        user: `${organizationObjectId()}#admin`,
        relation: "manager",
        object: `agentic_app:${appId}`,
      },
    ];
    if (
      app.installation.installed
      && app.installation.enabled
      && app.installation.visible
    ) {
      writes.push(...tuples);
    } else {
      deletes.push(...tuples);
    }
  }
  return { writes, deletes };
}

export async function reconcileConfiguredAgenticAppCasAccess(): Promise<void> {
  const diff = buildConfiguredAgenticAppCasTupleDiff(loadConfiguredAgenticApps());
  const result = await reconcileTupleDiff(diff, {
    source: "external_apps_configured_access",
  });
  if (result.enabled && (result.writes > 0 || result.deletes > 0)) {
    console.log(
      `[external-apps/cas] Reconciled configured access: ${result.writes} grants, ${result.deletes} revocations`,
    );
  }
}
