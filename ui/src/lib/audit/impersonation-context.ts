import { AsyncLocalStorage } from "async_hooks";
import { createHash } from "crypto";

export interface AuditImpersonationContext {
  actorSub: string;
  startedAt?: string;
}

const SUBJECT_SALT = process.env.AUDIT_SUBJECT_SALT ?? "caipe-098-audit";
const impersonationStorage = new AsyncLocalStorage<AuditImpersonationContext | undefined>();

function hashSubject(sub: string): string {
  return `sha256:${createHash("sha256").update(`${SUBJECT_SALT}:${sub}`).digest("hex")}`;
}

/** Bind audit attribution to the current request's asynchronous execution context. */
export function setAuditImpersonationContext(
  context: AuditImpersonationContext | undefined,
): void {
  impersonationStorage.enterWith(context);
}

export function getAuditImpersonationContext(): AuditImpersonationContext | undefined {
  return impersonationStorage.getStore();
}

/** Run recurring/background maintenance without inheriting a request actor. */
export function withoutAuditImpersonationContext<T>(callback: () => T): T {
  return impersonationStorage.run(undefined, callback);
}

/** Attach the real administrator while preserving the impersonated subject. */
export function withAuditImpersonationActor(
  event: Record<string, unknown>,
  explicitContext?: AuditImpersonationContext,
): Record<string, unknown> {
  const context = explicitContext ?? getAuditImpersonationContext();
  if (!context?.actorSub) return event;
  return {
    ...event,
    actor_hash: hashSubject(context.actorSub),
    actor_ref: `user:${context.actorSub}`,
    impersonation: true,
    ...(context.startedAt ? { impersonation_started_at: context.startedAt } : {}),
  };
}
