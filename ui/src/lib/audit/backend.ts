/**
 * Audit backend factory.
 *
 * Reads AUDIT_LOG_BACKEND once at first call and returns a module-level
 * singleton used by all audit write-paths. The UI no longer writes audit
 * storage directly; the only supported backend is:
 *   - "service" — posts JSON batches to audit-service
 *   - "off" / "disabled" / "none" — drops audit events intentionally
 *
 * AuditBackend.write() must never throw; implementations log errors internally.
 */

import { withAuditImpersonationActor } from "./impersonation-context";

export interface AuditBackend {
  /** Fire-and-forget write. Must never throw; log errors internally. */
  write(event: Record<string, unknown>): void;
}

let _backend: AuditBackend | null = null;

class NoopAuditBackend implements AuditBackend {
  write(_event: Record<string, unknown>): void {
    // assisted-by Codex Codex-sonnet-4-6
    void _event;
  }
}

class AttributingAuditBackend implements AuditBackend {
  constructor(private readonly delegate: AuditBackend) {}

  write(event: Record<string, unknown>): void {
    this.delegate.write(withAuditImpersonationActor(event));
  }
}

export function getAuditBackend(): AuditBackend {
  if (_backend) return _backend;
  _backend = createBackend();
  return _backend;
}

export function getBackendName(): string {
  return (process.env.AUDIT_LOG_BACKEND ?? "service").trim().toLowerCase();
}

function createBackend(): AuditBackend {
  const backendName = getBackendName();

  if (["off", "disabled", "none"].includes(backendName)) {
    console.warn("[audit] backend=off; audit events will be dropped");
    return new NoopAuditBackend();
  }

  if (backendName === "service") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ServiceBackend } = require("./backends/service-backend") as typeof import("./backends/service-backend");
    const serviceUrl = process.env.AUDIT_SERVICE_URL ?? process.env.AUDIT_LOG_SERVICE_URL ?? "http://audit-service:8010";
    const flushIntervalMs = parseInt(process.env.AUDIT_SERVICE_FLUSH_INTERVAL_MS ?? "1000", 10);
    const flushBatchSize = parseInt(process.env.AUDIT_SERVICE_FLUSH_BATCH_SIZE ?? "100", 10);
    console.info(`[audit] backend=service url=${serviceUrl}`);
    return new AttributingAuditBackend(
      new ServiceBackend(serviceUrl, flushIntervalMs, flushBatchSize),
    );
  }

  console.warn(
    `[audit] unsupported AUDIT_LOG_BACKEND="${backendName}"; local/S3 writes moved to audit-service, so audit events will be dropped`,
  );
  return new NoopAuditBackend();
}
