import { ApiError } from "@/lib/api-error";

export interface AuditQuery {
  since?: Date | string;
  until?: Date | string;
  window?: string;
  cursor?: string;
  limit?: number;
  type?: string;
  outcome?: string;
  tenant_id?: string;
  subject_ref?: string;
  subject_hash?: string;
  resource_ref?: string;
  correlation_id?: string;
  decision_id?: string;
  component?: string;
  source?: string;
  action?: string;
  capability?: string;
  reason_code?: string;
  agent_name?: string;
  tool_name?: string;
  user_email?: string;
}

export interface AuditPage<T = Record<string, unknown>> {
  records: T[];
  limit: number;
  cursor: string;
  next_cursor: string | null;
  since: string;
  until: string;
  as_of: string;
}

export class AuditServiceError extends ApiError {
  constructor(message = "Audit queries unavailable; no conclusions can be drawn from these results", status = 503) {
    super(message, status, status === 400 ? "AUDIT_QUERY_INVALID" : "AUDIT_UNAVAILABLE");
    this.name = "AuditServiceError";
  }
}

export function auditServiceUrl(): string {
  return (process.env.AUDIT_SERVICE_URL ?? process.env.AUDIT_LOG_SERVICE_URL ?? "http://audit-service:8010").replace(/\/+$/, "");
}

interface AuditClientOptions {
  baseUrl: string;
  enabled?: boolean;
  batchSize?: number;
  flushIntervalMs?: number;
}

/** The BFF's only event transport. Audit-service owns storage and archival. */
export class AuditClient {
  readonly enabled: boolean;
  private readonly baseUrl: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private buffer: object[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> | undefined;

  constructor(options: AuditClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.enabled = options.enabled ?? true;
    this.batchSize = positiveInteger(options.batchSize, 100);
    this.flushIntervalMs = positiveInteger(options.flushIntervalMs, 1_000);
  }

  /** Best-effort delivery must not change an authorization decision. */
  append(event: object): void {
    if (!this.enabled) return;
    this.buffer.push(event);
    if (!this.timer) {
      this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
      this.timer.unref?.();
    }
    if (this.buffer.length >= this.batchSize) void this.flush();
  }

  /** Single-flight, bounded HTTP batches. Failed batches are logged, not retried. */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.flushBuffered().finally(() => { this.flushing = undefined; });
    }
    return this.flushing;
  }

  private async flushBuffered(): Promise<void> {
    while (this.buffer.length > 0) {
      const events = this.buffer.splice(0, this.batchSize);
      try {
        await this.request("/v1/audit/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ events }),
        });
      } catch (error) {
        console.warn(`[audit] Failed to submit ${events.length} events; delivery remains best-effort`, error);
      }
    }
  }

  /** One cursor page. Failures are never disguised as an empty successful query. */
  async queryPage<T = Record<string, unknown>>(query: AuditQuery = {}, options: { timeoutMs?: number } = {}): Promise<AuditPage<T>> {
    if (!this.enabled) throw new AuditServiceError("Audit collection is disabled or its backend is unsupported");
    const params = new URLSearchParams({ limit: String(query.limit ?? 1_000) });
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, value instanceof Date ? value.toISOString() : String(value));
    }
    const response = await this.request(`/v1/audit/events?${params}`, {}, options.timeoutMs);
    let page: AuditPage<T>;
    try {
      page = await response.json();
    } catch {
      throw new AuditServiceError("Invalid audit query response");
    }
    if (!page || !Array.isArray(page.records) || page.records.some((record) => !record || typeof record !== "object" || Array.isArray(record)) ||
        !Number.isInteger(page.limit) || page.limit < 1 || typeof page.cursor !== "string" || !page.cursor ||
        !(page.next_cursor === null || (typeof page.next_cursor === "string" && page.next_cursor.length > 0)) ||
        ![page.since, page.until, page.as_of].every((value) => typeof value === "string" && Number.isFinite(Date.parse(value)))) {
      throw new AuditServiceError("Invalid audit query response");
    }
    return page;
  }

  private async request(path: string, init: RequestInit, timeoutMs = 10_000): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new AuditServiceError();
    }
    if (!response.ok) {
      if (init.method !== "POST" && response.status === 400) {
        throw new AuditServiceError("Invalid audit query or cursor; start a new query", 400);
      }
      throw new AuditServiceError(`Audit service unavailable (HTTP ${response.status})`);
    }
    return response;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

let client: AuditClient | undefined;

export function getAuditClient(): AuditClient {
  if (!client) {
    const backend = (process.env.AUDIT_LOG_BACKEND ?? "service").trim().toLowerCase();
    if (backend !== "service") console.warn(`[audit] AUDIT_LOG_BACKEND=${backend}; event submission and queries are disabled`);
    client = new AuditClient({
      baseUrl: auditServiceUrl(),
      enabled: backend === "service",
      batchSize: Number(process.env.AUDIT_SERVICE_FLUSH_BATCH_SIZE),
      flushIntervalMs: Number(process.env.AUDIT_SERVICE_FLUSH_INTERVAL_MS),
    });
  }
  return client;
}
