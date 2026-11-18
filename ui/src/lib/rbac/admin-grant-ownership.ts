import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { withAgentMutationLock } from "@/lib/agent-mutation-lock";
import { PolicyWritePendingError } from "@/lib/authz/engine";
import { getRbacCollection } from "./mongo-collections";
import { adminBaselineGrantDefinitions } from "./baseline-access";
import type { OpenFgaTupleKey, TeamResourceTupleDiff } from "./openfga";

const heldSubjects = new AsyncLocalStorage<ReadonlySet<string>>();

/** The Mongo _id lock is shared by replicas; nested adapter writes reuse it. */
export async function withAdminGrantLock<T>(subject: string, operation: () => Promise<T>): Promise<T> {
  if (heldSubjects.getStore()?.has(subject)) return operation();
  const deadline = Date.now() + 10_000;
  for (;;) {
    let started = false;
    try {
      return await withAgentMutationLock(`rbac-admin:${subject}`, () => {
        started = true;
        return heldSubjects.run(new Set([...(heldSubjects.getStore() ?? []), subject]), operation);
      });
    } catch (error) {
      // Never replay an operation whose side effects have started.
      if (started || (error as { statusCode?: number }).statusCode !== 409 || Date.now() >= deadline) throw error;
      await delay(25);
    }
  }
}

interface AdminGrantOwnership {
  _id: string;
  login: boolean;
  independent: boolean;
  independent_pending?: boolean;
}

export function isDirectAdminBaselineTuple(tuple: OpenFgaTupleKey): boolean {
  if (!tuple.user.startsWith("user:") || tuple.user === "user:*" || tuple.user.includes("#")) return false;
  return adminBaselineGrantDefinitions().some((definition) => {
    const candidate = definition.tuple(tuple.user.slice(5));
    return candidate.relation === tuple.relation && candidate.object === tuple.object;
  });
}

/**
 * Keep separate reasons for the same direct grant. Intent is durable before
 * OpenFGA writes. New independent grants remain pending until acknowledged;
 * an uncertain grant blocks reconciliation instead of becoming an active reason.
 * An existing tuple with no ledger is ambiguous and must never be claimed by login.
 */
export async function withAdminGrantOwnership<T>(
  diff: TeamResourceTupleDiff,
  source: "login" | "independent" | "purge",
  exists: (tuple: OpenFgaTupleKey) => Promise<boolean>,
  apply: (diff: TeamResourceTupleDiff) => Promise<T>,
): Promise<T> {
  const tracked = [...diff.writes, ...diff.deletes].filter(isDirectAdminBaselineTuple);
  if (!tracked.length) return apply(diff);
  const subjects = [...new Set(tracked.map((tuple) => tuple.user.slice(5)))].sort();
  async function acquire(index: number): Promise<T> {
    if (index < subjects.length) return withAdminGrantLock(subjects[index], () => acquire(index + 1));
    const ledger = await getRbacCollection<AdminGrantOwnership>("adminGrantOwnership");
    const writes = diff.writes.filter((tuple) => !isDirectAdminBaselineTuple(tuple));
    const deletes = diff.deletes.filter((tuple) => !isDirectAdminBaselineTuple(tuple));
    // A replacement in the same diff gives the write precedence.
    const changes = new Map<string, { tuple: OpenFgaTupleKey; assign: boolean }>();
    for (const tuple of diff.deletes.filter(isDirectAdminBaselineTuple)) changes.set(JSON.stringify([tuple.user, tuple.relation, tuple.object]), { tuple, assign: false });
    for (const tuple of diff.writes.filter(isDirectAdminBaselineTuple)) changes.set(JSON.stringify([tuple.user, tuple.relation, tuple.object]), { tuple, assign: true });
    const plans = [];
    for (const { tuple, assign } of changes.values()) {
      const _id = JSON.stringify([tuple.user, tuple.relation, tuple.object]);
      const recorded = await ledger.findOne({ _id });
      if (recorded?.independent_pending) throw new PolicyWritePendingError();
      plans.push({ _id, tuple, assign, recorded });
    }
    const pending: AdminGrantOwnership[] = [];
    try {
      for (const { _id, tuple, assign, recorded } of plans) {
        if (!recorded && source === "login" && !assign) {
          if (await exists(tuple)) console.warn("[LoginOpenFGA] Unattributed admin grant retained; operator review required", tuple);
          continue;
        }
        const ownership: AdminGrantOwnership = recorded ?? {
          _id, login: false, independent: source === "login" && await exists(tuple),
        };
        const pendingGrant = source === "independent" && assign && !ownership.independent;
        if (source === "purge") {
          // Explicit resource/user cleanup must not leave a reason that a later
          // login reconciliation could use to recreate the deleted tuple.
          ownership.login = false;
          ownership.independent = false;
        } else {
          ownership[source] = assign;
        }
        if (pendingGrant) {
          // Do not activate an intent before OpenFGA acknowledges it. An uncertain
          // response retains the marker and requires verification before retry.
          pending.push(ownership);
          await ledger.updateOne({ _id }, { $set: { login: ownership.login, independent: false, independent_pending: true } }, { upsert: true });
        } else {
          await ledger.updateOne({ _id }, { $set: { login: ownership.login, independent: ownership.independent } }, { upsert: true });
        }
        (ownership.login || ownership.independent ? writes : deletes).push(tuple);
      }
      const result = await apply({ writes, deletes });
      for (const ownership of pending) {
        await ledger.updateOne({ _id: ownership._id }, {
          $set: { independent: true }, $unset: { independent_pending: "" },
        });
      }
      return result;
    } catch (error) {
      // Do not compensate an unacknowledged request: it may still be in flight.
      // Confirmation can also fail after committing, so report pending, not failed.
      if (pending.length) throw new PolicyWritePendingError(error);
      throw error;
    }
  }
  return acquire(0);
}
