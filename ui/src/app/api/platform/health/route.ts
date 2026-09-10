import net from "node:net";

import { NextRequest, NextResponse } from "next/server";

import {
  getInternalA2AUrl,
  getServerConfig,
  getServerOnlyConfig,
} from "@/lib/config";
import {
  getSlackIntegrationToken,
  isSlackIntegrationEnabled,
  isWebexIntegrationEnabled,
} from "@/lib/integration-config";
import {
  createJsonResponseCacheStore,
  envTtlMs,
  withJsonResponseCache,
} from "@/lib/server-response-cache";
import { callSlackBotAdmin } from "@/lib/slack-bot-admin";
import { callWebexBotAdmin } from "@/lib/webex-bot-admin";

export const runtime = "nodejs";

type CapabilityStatus = "healthy" | "degraded" | "down" | "disabled";
type CapabilityGroup = "runtime" | "knowledge" | "identity" | "observability" | "messaging";
type DiagnosticProbeStatus = "healthy" | "warning" | "down";
type DiagnosticProbeGroup = "runtime" | "identity" | "storage" | "knowledge" | "bootstrap" | "observability";

interface CapabilityResult {
  id: string;
  label: string;
  group: CapabilityGroup;
  status: CapabilityStatus;
  required: boolean;
  description: string;
  detail: string;
  latency_ms: number | null;
  version: string | null;
}

interface AuditServiceStatusPayload {
  running?: unknown;
  backend?: unknown;
  storage?: unknown;
  queue_size?: unknown;
  queue_max_size?: unknown;
  rejected_events?: unknown;
  failed_flushes?: unknown;
  last_error?: unknown;
  last_flush_at?: unknown;
}

interface DiagnosticProbeRemediation {
  label: string;
  href: string;
  description: string;
}

interface DiagnosticProbeResult {
  id: string;
  label: string;
  group: DiagnosticProbeGroup;
  status: DiagnosticProbeStatus;
  detail: string;
  target: string;
  latency_ms: number | null;
  remediation?: DiagnosticProbeRemediation;
}

const HTTP_TIMEOUT_MS = 3000;
const TCP_TIMEOUT_MS = 2000;
const healthCache = createJsonResponseCacheStore();
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

function envValue(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value || value.startsWith("#")) return null;
  if (value.startsWith("<") && value.endsWith(">")) return null;
  if (value.toLowerCase().includes("your-")) return null;
  return value;
}

function envExplicitlyDisabled(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value ? DISABLED_VALUES.has(value) : false;
}

function componentVersion(componentId: string): string | null {
  const componentEnvName = `PLATFORM_COMPONENT_VERSION_${componentId.toUpperCase().replace(/-/g, "_")}`;
  return envValue(componentEnvName) ?? envValue("CAIPE_RELEASE_VERSION");
}

function envPort(name: string, defaultPort: number): number {
  const raw = envValue(name);
  if (!raw) return defaultPort;
  const tcpMatch = raw.match(/^tcp:\/\/[^:]+:(\d+)/);
  if (tcpMatch) return Number(tcpMatch[1]);
  return Number(raw) || defaultPort;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function auditServiceUrl(): string {
  return (process.env.AUDIT_SERVICE_URL ?? process.env.AUDIT_LOG_SERVICE_URL ?? "http://audit-service:8010").replace(/\/$/, "");
}

function isHealthyStatusPayload(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { status?: unknown }).status === "healthy"
  );
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out`)), HTTP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function disabledCapability(input: {
  id: string;
  label: string;
  group: CapabilityGroup;
  detail: string;
  description: string;
}): CapabilityResult {
  return {
    ...input,
    status: "disabled",
    required: false,
    description: input.description,
    latency_ms: null,
    version: componentVersion(input.id),
  };
}

async function probeHttpCapability({
  id,
  label,
  group,
  target,
  required,
  description,
  degradedOnFailure = !required,
  healthyDetail = "Reachable",
  failureLabel,
  healthyPayload,
}: {
  id: string;
  label: string;
  group: CapabilityGroup;
  target: string;
  required: boolean;
  description: string;
  degradedOnFailure?: boolean;
  healthyDetail?: string;
  failureLabel: string;
  healthyPayload?: (payload: unknown) => boolean;
}): Promise<CapabilityResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(target, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });
    const latencyMs = Date.now() - startedAt;
    if (response.ok) {
      if (healthyPayload) {
        const payload = await response.clone().json().catch(() => null);
        if (!healthyPayload(payload)) {
          return {
            id,
            label,
            group,
            status: degradedOnFailure ? "degraded" : "down",
            required,
            description,
            detail: `${failureLabel} returned unhealthy status`,
            latency_ms: latencyMs,
            version: componentVersion(id),
          };
        }
      }
      return {
        id,
        label,
        group,
        status: "healthy",
        required,
        description,
        detail: healthyDetail,
        latency_ms: latencyMs,
        version: componentVersion(id),
      };
    }
    return {
      id,
      label,
      group,
      status: degradedOnFailure ? "degraded" : "down",
      required,
      description,
      detail: `${failureLabel} returned HTTP ${response.status}`,
      latency_ms: latencyMs,
      version: componentVersion(id),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "request failed";
    const detail = errorMessage === "fetch failed"
      ? `${failureLabel} is unreachable`
      : `${failureLabel} failed: ${errorMessage}`;

    return {
      id,
      label,
      group,
      status: degradedOnFailure ? "degraded" : "down",
      required,
      description,
      detail,
      latency_ms: Date.now() - startedAt,
      version: componentVersion(id),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function probeHttpDiagnostic({
  id,
  label,
  group,
  target,
  headers,
  remediation,
  failureStatus = "down",
  failureDetailPrefix,
}: {
  id: string;
  label: string;
  group: DiagnosticProbeGroup;
  target: string;
  headers?: HeadersInit;
  remediation?: DiagnosticProbeRemediation;
  failureStatus?: DiagnosticProbeStatus;
  failureDetailPrefix?: string;
}): Promise<DiagnosticProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(target, {
      method: "GET",
      headers,
      signal: controller.signal,
      cache: "no-store",
    });
    const latencyMs = Date.now() - startedAt;
    const detail = `HTTP ${response.status}`;
    return {
      id,
      label,
      group,
      status: response.ok ? "healthy" : failureStatus,
      detail: response.ok || !failureDetailPrefix ? detail : `${failureDetailPrefix}: ${detail}`,
      target,
      latency_ms: latencyMs,
      remediation: response.ok ? undefined : remediation,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return {
      id,
      label,
      group,
      status: failureStatus,
      detail: failureDetailPrefix ? `${failureDetailPrefix}: ${message}` : message,
      target,
      latency_ms: Date.now() - startedAt,
      remediation,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function probeTcpDiagnostic({
  id,
  label,
  group,
  host,
  port,
  remediation,
}: {
  id: string;
  label: string;
  group: DiagnosticProbeGroup;
  host: string;
  port: number;
  remediation?: DiagnosticProbeRemediation;
}): Promise<DiagnosticProbeResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: TCP_TIMEOUT_MS });

    const finish = (status: DiagnosticProbeStatus, detail: string) => {
      socket.destroy();
      resolve({
        id,
        label,
        group,
        status,
        detail,
        target: `${host}:${port}`,
        latency_ms: Date.now() - startedAt,
        remediation: status === "healthy" ? undefined : remediation,
      });
    };

    socket.once("connect", () => finish("healthy", "TCP connection accepted"));
    socket.once("timeout", () => finish("down", "connection timed out"));
    socket.once("error", (error) => finish("down", error.message));
  });
}

async function probeOpenFgaBootstrap(openfgaUrl: string): Promise<DiagnosticProbeResult> {
  const startedAt = Date.now();
  const storeName = envValue("OPENFGA_STORE_NAME") || "caipe-openfga";
  const remediation = {
    label: "OpenFGA",
    href: "/admin/security/access-explorer",
    description: "Inspect OpenFGA connectivity and seeded authorization model.",
  };

  try {
    const storesResponse = await fetch(`${openfgaUrl}/stores`, { method: "GET", cache: "no-store" });
    if (!storesResponse.ok) {
      return {
        id: "openfga-bootstrap",
        label: "OpenFGA Bootstrap",
        group: "bootstrap",
        status: "down",
        detail: `Store discovery HTTP ${storesResponse.status}`,
        target: `${openfgaUrl}/stores`,
        latency_ms: Date.now() - startedAt,
        remediation,
      };
    }
    const storesBody = (await storesResponse.json()) as { stores?: Array<{ id?: string; name?: string }> };
    const store = storesBody.stores?.find((candidate) => candidate.name === storeName);
    if (!store?.id) {
      return {
        id: "openfga-bootstrap",
        label: "OpenFGA Bootstrap",
        group: "bootstrap",
        status: "down",
        detail: `Store ${storeName} not found`,
        target: `${openfgaUrl}/stores`,
        latency_ms: Date.now() - startedAt,
        remediation,
      };
    }

    const modelsResponse = await fetch(`${openfgaUrl}/stores/${store.id}/authorization-models`, {
      method: "GET",
      cache: "no-store",
    });
    if (!modelsResponse.ok) {
      return {
        id: "openfga-bootstrap",
        label: "OpenFGA Bootstrap",
        group: "bootstrap",
        status: "down",
        detail: `Model discovery HTTP ${modelsResponse.status}`,
        target: `${openfgaUrl}/stores/${store.id}/authorization-models`,
        latency_ms: Date.now() - startedAt,
        remediation,
      };
    }
    const modelsBody = (await modelsResponse.json()) as { authorization_models?: unknown[] };
    if (!Array.isArray(modelsBody.authorization_models) || modelsBody.authorization_models.length === 0) {
      return {
        id: "openfga-bootstrap",
        label: "OpenFGA Bootstrap",
        group: "bootstrap",
        status: "down",
        detail: "No authorization model found",
        target: `${openfgaUrl}/stores/${store.id}/authorization-models`,
        latency_ms: Date.now() - startedAt,
        remediation,
      };
    }

    return {
      id: "openfga-bootstrap",
      label: "OpenFGA Bootstrap",
      group: "bootstrap",
      status: "healthy",
      detail: "Store and model ready",
      target: `${openfgaUrl}/stores/${store.id}`,
      latency_ms: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      id: "openfga-bootstrap",
      label: "OpenFGA Bootstrap",
      group: "bootstrap",
      status: "down",
      detail: error instanceof Error ? error.message : "bootstrap check failed",
      target: `${openfgaUrl}/stores`,
      latency_ms: Date.now() - startedAt,
      remediation,
    };
  }
}

async function probeKeycloakBootstrap(): Promise<DiagnosticProbeResult> {
  const remediation = {
    label: "Keycloak Health",
    href: "/admin/security/keycloak",
    description: "Inspect Keycloak realm, credentials, and reconciliation status.",
  };
  try {
    const { getKeycloakMigrationHealth } = await import("@/lib/rbac/keycloak-migration-health");
    const health = await getKeycloakMigrationHealth({ actor: "platform-health" });
    const failingInvariants = health.keycloak_invariants?.summary.failing ?? 0;
    if (!health.keycloak.reachable || health.keycloak.status !== "reachable") {
      return {
        id: "keycloak-bootstrap",
        label: "Keycloak Bootstrap",
        group: "bootstrap",
        status: "warning",
        detail: health.keycloak.probe_error || `Realm ${health.keycloak.realm} needs attention`,
        target: health.keycloak.realm,
        latency_ms: null,
        remediation,
      };
    }
    if (health.schema_area.status !== "current" || failingInvariants > 0) {
      return {
        id: "keycloak-bootstrap",
        label: "Keycloak Bootstrap",
        group: "bootstrap",
        status: "warning",
        detail:
          health.schema_area.status !== "current"
            ? `Schema ${health.schema_area.current_version ?? "unknown"} -> ${health.schema_area.target_version}`
            : `${failingInvariants} invariant${failingInvariants === 1 ? "" : "s"} failing`,
        target: health.keycloak.realm,
        latency_ms: null,
        remediation,
      };
    }
    return {
      id: "keycloak-bootstrap",
      label: "Keycloak Bootstrap",
      group: "bootstrap",
      status: "healthy",
      detail: "Realm and reconciliation ready",
      target: health.keycloak.realm,
      latency_ms: null,
    };
  } catch (error) {
    return {
      id: "keycloak-bootstrap",
      label: "Keycloak Bootstrap",
      group: "bootstrap",
      status: "warning",
      detail: error instanceof Error ? error.message : "bootstrap check failed",
      target: envValue("KEYCLOAK_REALM") || "caipe",
      latency_ms: null,
      remediation,
    };
  }
}

async function probeRebacMigrations(): Promise<DiagnosticProbeResult> {
  const remediation = {
    label: "Migration Assistant",
    href: "/admin/security/migrations",
    description: "Open the migration assistant to review and apply required schema migrations.",
  };
  try {
    const { getMigrationBlockingStatus } = await import("@/lib/rbac/migrations/registry");
    const status = await getMigrationBlockingStatus({ actor: "platform-health" });
    if (status.is_blocking) {
      return {
        id: "rebac-migrations",
        label: "RBAC Migrations",
        group: "bootstrap",
        status: "warning",
        detail: `${status.blocking_required_count} blocking migration${status.blocking_required_count === 1 ? "" : "s"} pending`,
        target: status.release,
        latency_ms: null,
        remediation,
      };
    }
    if (status.needs_version_bootstrap) {
      return {
        id: "rebac-migrations",
        label: "RBAC Migrations",
        group: "bootstrap",
        status: "warning",
        detail: `${status.version_bootstrap_required_count} schema area${status.version_bootstrap_required_count === 1 ? "" : "s"} need version metadata`,
        target: status.release,
        latency_ms: null,
        remediation,
      };
    }
    return {
      id: "rebac-migrations",
      label: "RBAC Migrations",
      group: "bootstrap",
      status: "healthy",
      detail: "Current",
      target: status.release,
      latency_ms: null,
    };
  } catch (error) {
    return {
      id: "rebac-migrations",
      label: "RBAC Migrations",
      group: "bootstrap",
      status: "warning",
      detail: error instanceof Error ? error.message : "migration status unavailable",
      target: "schema_migrations",
      latency_ms: null,
      remediation,
    };
  }
}

function webIngestorReadiness(ragServerHealthy: boolean, redisHealthy: boolean): DiagnosticProbeResult {
  const status: DiagnosticProbeStatus = ragServerHealthy && redisHealthy ? "healthy" : "warning";
  return {
    id: "web-ingestor",
    label: "Web Ingestor",
    group: "knowledge",
    status,
    detail: status === "healthy" ? "Queue ready; worker liveness not exposed" : "Requires RAG server and Redis",
    target: "web-ingestor",
    latency_ms: null,
    remediation:
      status === "healthy"
        ? undefined
        : {
            label: "RAG Setup",
            href: "/knowledge-bases/ingest",
            description: "Check that the rag and web_ingestor compose profiles are running.",
          },
  };
}

async function buildDiagnosticProbes(): Promise<DiagnosticProbeResult[]> {
  // assisted-by Codex Codex-sonnet-4-6
  // Admin diagnostics restore dependency probes without making the header UX noisy.
  const keycloakUrl = trimTrailingSlash(envValue("KEYCLOAK_URL") || "http://keycloak:7080");
  const keycloakRealm = envValue("KEYCLOAK_REALM") || "caipe";
  const openfgaUrl = trimTrailingSlash(envValue("OPENFGA_HTTP") || "http://openfga:8080");
  const ragServerUrl = trimTrailingSlash(envValue("RAG_SERVER_URL") || "http://rag-server:9446");
  const dynamicAgentsUrl = trimTrailingSlash(
    envValue("DYNAMIC_AGENTS_URL") || envValue("DA_SERVER_BASE_URL") || "http://dynamic-agents:8001",
  );
  const agentgatewayAdminUrl = trimTrailingSlash(
    envValue("AGENTGATEWAY_ADMIN_CONFIG_URL") || "http://agentgateway:15000/config",
  );
  const agentgatewayTargetsUrl =
    envValue("AGENTGATEWAY_TARGETS_URL") || "http://caipe-ui:3000/api/internal/agentgateway/mcp-targets";
  const agentgatewayTargetsToken =
    envValue("AGENTGATEWAY_TARGETS_TOKEN") || "agentgateway-config-bridge-dev-token";

  const probes = await Promise.all([
    probeHttpDiagnostic({
      id: "keycloak",
      label: "Keycloak",
      group: "identity",
      target: `${keycloakUrl}/realms/${keycloakRealm}/protocol/openid-connect/certs`,
      remediation: {
        label: "Keycloak Health",
        href: "/admin/security/keycloak",
        description: "Inspect Keycloak realm, credentials, and reconciliation status.",
      },
    }),
    probeHttpDiagnostic({
      id: "openfga",
      label: "OpenFGA",
      group: "identity",
      target: `${openfgaUrl}/healthz`,
      remediation: {
        label: "OpenFGA",
        href: "/admin/security/access-explorer",
        description: "Inspect OpenFGA connectivity and seeded authorization model.",
      },
    }),
    probeTcpDiagnostic({
      id: "openfga-authz-bridge",
      label: "OpenFGA Bridge",
      group: "identity",
      host: envValue("OPENFGA_AUTHZ_BRIDGE_HOST") || "openfga-authz-bridge",
      port: envPort("OPENFGA_AUTHZ_BRIDGE_PORT", 9100),
    }),
    probeHttpDiagnostic({
      id: "dynamic-agents-runtime",
      label: "Dynamic Agents Runtime",
      group: "runtime",
      target: `${dynamicAgentsUrl}/health`,
      remediation: {
        label: "Dynamic Agents",
        href: "/agents",
        description: "Check dynamic agents service logs and dependencies.",
      },
    }),
    probeHttpDiagnostic({
      id: "agentgateway-config-bridge",
      label: "AgentGateway Config Bridge",
      group: "runtime",
      target: agentgatewayTargetsUrl,
      headers: {
        authorization: `Bearer ${agentgatewayTargetsToken}`,
      },
      remediation: {
        label: "AgentGateway",
        href: "/admin/operations/health",
        description: "Check AgentGateway config bridge logs and target sync token configuration.",
      },
    }),
    probeHttpDiagnostic({
      id: "agentgateway",
      label: "AgentGateway",
      group: "runtime",
      target: agentgatewayAdminUrl,
      remediation: {
        label: "AgentGateway",
        href: "/admin/operations/health",
        description: "Check AgentGateway listener and static target configuration.",
      },
    }),
    probeTcpDiagnostic({
      id: "caipe-mongodb",
      label: "MongoDB",
      group: "storage",
      host: envValue("MONGODB_HOST") || "caipe-mongodb",
      port: envPort("MONGODB_PORT", 27017),
    }),
    probeHttpDiagnostic({
      id: "audit-service",
      label: "Audit Service",
      group: "observability",
      target: `${auditServiceUrl()}/v1/audit/status`,
      failureStatus: "warning",
      failureDetailPrefix: "optional audit path unavailable",
      remediation: {
        label: "Audit Service",
        href: "/admin/operations/health",
        description: "Check audit-service logs, queue status, and local/S3 storage configuration.",
      },
    }),
    probeTcpDiagnostic({
      id: "keycloak-postgres",
      label: "Keycloak Postgres",
      group: "storage",
      host: envValue("KEYCLOAK_POSTGRES_HOST") || "keycloak-postgres",
      port: envPort("KEYCLOAK_POSTGRES_PORT", 5432),
    }),
    probeTcpDiagnostic({
      id: "openfga-postgres",
      label: "OpenFGA Postgres",
      group: "storage",
      host: envValue("OPENFGA_POSTGRES_HOST") || "openfga-postgres",
      port: envPort("OPENFGA_POSTGRES_PORT", 5432),
    }),
    probeHttpDiagnostic({
      id: "rag-server",
      label: "RAG Server",
      group: "knowledge",
      target: `${ragServerUrl}/healthz`,
      remediation: {
        label: "Knowledge Bases",
        href: "/knowledge-bases",
        description: "Check RAG server dependencies and compose profile.",
      },
    }),
    probeTcpDiagnostic({
      id: "rag-redis",
      label: "RAG Redis",
      group: "knowledge",
      host: envValue("RAG_REDIS_HOST") || "rag-redis",
      port: envPort("RAG_REDIS_PORT", 6379),
    }),
    probeHttpDiagnostic({
      id: "milvus",
      label: "Milvus",
      group: "knowledge",
      target: trimTrailingSlash(envValue("MILVUS_HEALTH_URL") || "http://milvus-standalone:9091/healthz"),
    }),
    probeTcpDiagnostic({
      id: "milvus-minio",
      label: "Milvus MinIO",
      group: "knowledge",
      host: envValue("MILVUS_MINIO_HOST") || "milvus-minio",
      port: envPort("MILVUS_MINIO_PORT", 9000),
    }),
    probeTcpDiagnostic({
      id: "etcd",
      label: "etcd",
      group: "knowledge",
      host: envValue("ETCD_HOST") || "etcd",
      port: envPort("ETCD_PORT", 2379),
    }),
    probeOpenFgaBootstrap(openfgaUrl),
    probeKeycloakBootstrap(),
    probeRebacMigrations(),
  ]);

  const ragServerProbe = probes.find((probe) => probe.id === "rag-server");
  const ragRedisProbe = probes.find((probe) => probe.id === "rag-redis");
  probes.push(
    webIngestorReadiness(
      ragServerProbe?.status === "healthy",
      ragRedisProbe?.status === "healthy",
    ),
  );

  return probes;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function objectField(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function auditStorageDetail(payload: AuditServiceStatusPayload): string | null {
  const storage = objectField(payload.storage);
  if (!storage) return null;

  const detail = stringField(storage.detail);
  if (detail) return `storage=${detail}`;

  const backend = stringField(storage.backend) ?? stringField(payload.backend) ?? "unknown";
  const usedPercent = numberField(storage.used_percent);
  const freeBytes = numberField(storage.free_bytes);
  if (backend === "local" && usedPercent !== null) {
    return freeBytes !== null
      ? `storage=local disk ${usedPercent.toFixed(1)}% used (${Math.round(freeBytes / 1024 / 1024)} MiB free)`
      : `storage=local disk ${usedPercent.toFixed(1)}% used`;
  }

  return `storage=${backend}`;
}

function auditStatusDetail(payload: AuditServiceStatusPayload): string {
  const backend = stringField(payload.backend) ?? "unknown";
  const queueSize = numberField(payload.queue_size);
  const queueMaxSize = numberField(payload.queue_max_size);
  const failedFlushes = numberField(payload.failed_flushes) ?? 0;
  const rejectedEvents = numberField(payload.rejected_events) ?? 0;
  const lastFlushAt = stringField(payload.last_flush_at) ?? "never";
  const queueDetail =
    queueSize !== null && queueMaxSize !== null
      ? `queue ${queueSize}/${queueMaxSize}`
      : "queue unknown";
  const storageDetail = auditStorageDetail(payload);

  return [
    `backend=${backend}`,
    queueDetail,
    ...(storageDetail ? [storageDetail] : []),
    `failed_flushes=${failedFlushes}`,
    `rejected_events=${rejectedEvents}`,
    `last_flush=${lastFlushAt}`,
  ].join("; ");
}

async function probeAuditServiceCapability(auditBackend: string): Promise<CapabilityResult> {
  const normalizedBackend = auditBackend.trim().toLowerCase();

  if (["off", "disabled", "none"].includes(normalizedBackend)) {
    return disabledCapability({
      id: "audit-service",
      label: "Audit Service",
      group: "observability",
      description: "Collects and serves durable audit events.",
      detail: "Disabled by AUDIT_LOG_BACKEND",
    });
  }

  if (normalizedBackend !== "service") {
    return {
      id: "audit-service",
      label: "Audit Service",
      group: "observability",
      status: "degraded",
      required: false,
      description: "Collects and serves durable audit events.",
      detail: `AUDIT_LOG_BACKEND=${auditBackend} is unsupported by the UI; use service`,
      latency_ms: null,
      version: componentVersion("audit-service"),
    };
  }

  // assisted-by Codex Codex-sonnet-4-6
  // Audit health uses queue-worker state because a 200 response can still hide backpressure.
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(`${auditServiceUrl()}/v1/audit/status`, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store",
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        id: "audit-service",
        label: "Audit Service",
        group: "observability",
        status: "degraded",
        required: false,
        description: "Collects and serves durable audit events.",
        detail: `audit-service returned HTTP ${response.status}`,
        latency_ms: latencyMs,
        version: componentVersion("audit-service"),
      };
    }

    const payload = (await response.json().catch(() => ({}))) as AuditServiceStatusPayload;
    const issues: string[] = [];
    const queueSize = numberField(payload.queue_size);
    const queueMaxSize = numberField(payload.queue_max_size);
    const lastError = stringField(payload.last_error);
    const failedFlushes = numberField(payload.failed_flushes) ?? 0;
    const rejectedEvents = numberField(payload.rejected_events) ?? 0;
    const storage = objectField(payload.storage);
    const storageStatus = storage ? stringField(storage.status)?.toLowerCase() : null;
    const storageDetail = storage ? stringField(storage.detail) : null;

    if (payload.running !== true) issues.push("queue worker is not running");
    if (lastError) issues.push(`last error: ${lastError}`);
    if (storageStatus && !["healthy", "ok"].includes(storageStatus)) {
      issues.push(`storage ${storageStatus}: ${storageDetail ?? "storage health check failed"}`);
    }
    if (
      queueSize !== null &&
      queueMaxSize !== null &&
      queueMaxSize > 0 &&
      queueSize / queueMaxSize >= 0.8
    ) {
      issues.push(`queue pressure ${queueSize}/${queueMaxSize}`);
    }
    if (failedFlushes > 0) issues.push(`${failedFlushes} failed flushes`);
    if (rejectedEvents > 0) issues.push(`${rejectedEvents} rejected events`);

    return {
      id: "audit-service",
      label: "Audit Service",
      group: "observability",
      status: issues.length > 0 ? "degraded" : "healthy",
      required: false,
      description: "Collects and serves durable audit events.",
      detail:
        issues.length > 0
          ? `${issues.join("; ")}; ${auditStatusDetail(payload)}`
          : auditStatusDetail(payload),
      latency_ms: latencyMs,
      version: componentVersion("audit-service"),
    };
  } catch (error) {
    return {
      id: "audit-service",
      label: "Audit Service",
      group: "observability",
      status: "degraded",
      required: false,
      description: "Collects and serves durable audit events.",
      detail: `audit-service failed: ${error instanceof Error ? error.message : "request failed"}`,
      latency_ms: Date.now() - startedAt,
      version: componentVersion("audit-service"),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function probeSlackIntegration(): Promise<CapabilityResult | null> {
  if (envExplicitlyDisabled("SLACK_INTEGRATION_ENABLED")) {
    return disabledCapability({
      id: "slack-integration",
      label: "Slack",
      group: "messaging",
      description: "Slack messaging integration is not enabled for this deployment.",
      detail: "Not Configured",
    });
  }
  if (!isSlackIntegrationEnabled()) {
    return disabledCapability({
      id: "slack-integration",
      label: "Slack",
      group: "messaging",
      description: "Slack messaging integration is not enabled for this deployment.",
      detail: "Disabled",
    });
  }

  const startedAt = Date.now();
  const issues: string[] = [];

  if (!getSlackIntegrationToken()) {
    issues.push("Slack directory token is not configured on the UI service");
  }

  try {
    await withTimeout(
      callSlackBotAdmin("/admin/slack/routes/status"),
      "Slack bot admin check",
    );
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "Slack bot admin check failed");
  }

  return {
    id: "slack-integration",
    label: "Slack",
    group: "messaging",
    status: issues.length > 0 ? "degraded" : "healthy",
    required: false,
    description: "Checks Slack integration availability.",
    detail: issues.length > 0 ? issues.join("; ") : "Slack ready",
    latency_ms: Date.now() - startedAt,
    version: componentVersion("slack-integration"),
  };
}

async function probeWebexIntegration(): Promise<CapabilityResult | null> {
  if (envExplicitlyDisabled("WEBEX_INTEGRATION_ENABLED")) {
    return disabledCapability({
      id: "webex-integration",
      label: "Webex",
      group: "messaging",
      description: "Webex messaging integration is not enabled for this deployment.",
      detail: "Not Configured",
    });
  }
  if (!isWebexIntegrationEnabled()) {
    return disabledCapability({
      id: "webex-integration",
      label: "Webex",
      group: "messaging",
      description: "Webex messaging integration is not enabled for this deployment.",
      detail: "Disabled",
    });
  }

  const startedAt = Date.now();
  const issues: string[] = [];

  try {
    await withTimeout(
      callWebexBotAdmin("/admin/webex/routes/status"),
      "Webex bot admin check",
    );
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "Webex bot admin check failed");
  }

  return {
    id: "webex-integration",
    label: "Webex",
    group: "messaging",
    status: issues.length > 0 ? "degraded" : "healthy",
    required: false,
    description: "Checks Webex integration availability.",
    detail: issues.length > 0 ? issues.join("; ") : "Webex ready",
    latency_ms: Date.now() - startedAt,
    version: componentVersion("webex-integration"),
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  return withJsonResponseCache(request, healthCache, () => getPlatformHealth(request), {
    ttlMs: envTtlMs("PLATFORM_HEALTH_CACHE_TTL_MS", 5_000),
    varyHeaders: [],
    cacheableStatus: (status) => status === 200 || status === 503,
    maxEntries: 4,
  });
}

async function getPlatformHealth(request: NextRequest): Promise<NextResponse> {
  const config = getServerConfig();
  const serverOnly = getServerOnlyConfig();
  const dynamicAgentsUrl = trimTrailingSlash(config.dynamicAgentsUrl);
  const ragServerUrl = trimTrailingSlash(
    envValue("RAG_SERVER_URL") || envValue("NEXT_PUBLIC_RAG_URL") || "http://rag-server:9446",
  );
  const includeDiagnostics = new URL(request.url).searchParams.get("diagnostics") === "1";
  const capabilityResults = await Promise.all([
    probeHttpCapability({
      id: "chat-runtime",
      label: "Chat Runtime",
      group: "runtime",
      target: `${getInternalA2AUrl()}/health`,
      required: true,
      description: "Checks the runtime health endpoint used by the chat experience.",
      degradedOnFailure: false,
      healthyDetail: "Chat runtime reachable",
      failureLabel: "Chat runtime health check",
    }),
    config.dynamicAgentsEnabled
      ? probeHttpCapability({
          id: "dynamic-agents",
          label: "Dynamic Agents",
          group: "runtime",
          target: `${dynamicAgentsUrl}/healthz`,
          required: true,
          description: "Checks Dynamic Agents when custom agent runtime is enabled.",
          healthyDetail: "Runtime reachable",
          degradedOnFailure: false,
          failureLabel: "Dynamic Agents health check",
          healthyPayload: isHealthyStatusPayload,
        })
      : Promise.resolve(
          disabledCapability({
            id: "dynamic-agents",
            label: "Dynamic Agents",
            group: "runtime",
            description: "Custom agent runtime is not enabled for this deployment.",
            detail: "Disabled by DYNAMIC_AGENTS_ENABLED",
          }),
        ),
    config.ragEnabled
      ? probeHttpCapability({
          id: "knowledge-bases",
          label: "Knowledge Bases",
          group: "knowledge",
          target: `${ragServerUrl}/healthz`,
          required: false,
          description: "Checks the RAG API used by Knowledge Bases.",
          healthyDetail: "RAG API reachable",
          failureLabel: "Knowledge Bases health check",
        })
      : Promise.resolve(
          disabledCapability({
            id: "knowledge-bases",
            label: "Knowledge Bases",
            group: "knowledge",
            description: "Knowledge Bases are not enabled for this deployment.",
            detail: "Disabled by RAG_ENABLED",
          }),
        ),
    Promise.resolve({
      id: "authentication",
      label: "Authentication",
      group: "identity",
      status: config.ssoEnabled ? "healthy" : "disabled",
      required: false,
      description: "Reads the UI SSO configuration.",
      detail: config.ssoEnabled ? "SSO enabled" : "SSO disabled",
      latency_ms: null,
      version: componentVersion("authentication"),
    } satisfies CapabilityResult),
    Promise.resolve({
      id: "metrics",
      label: "Metrics",
      group: "observability",
      status: serverOnly.prometheusUrl ? "healthy" : "disabled",
      required: false,
      description: "Reads the UI Prometheus configuration.",
      detail: serverOnly.prometheusUrl ? "Prometheus configured" : "Prometheus not configured",
      latency_ms: null,
      version: componentVersion("metrics"),
    } satisfies CapabilityResult),
    probeAuditServiceCapability(config.auditLogBackend),
    probeSlackIntegration(),
    probeWebexIntegration(),
  ]);
  const capabilities = capabilityResults.filter(
    (capability): capability is CapabilityResult => capability !== null,
  );

  const down = capabilities.filter((capability) => capability.status === "down").length;
  const degraded = capabilities.filter((capability) => capability.status === "degraded").length;
  const disabled = capabilities.filter((capability) => capability.status === "disabled").length;
  const healthy = capabilities.filter((capability) => capability.status === "healthy").length;
  const requiredDown = capabilities.some(
    (capability) => capability.required && capability.status === "down",
  );
  const status = requiredDown ? "down" : degraded > 0 ? "degraded" : "healthy";
  const probes = includeDiagnostics ? await buildDiagnosticProbes() : undefined;
  const probeDown = probes?.filter((probe) => probe.status === "down").length ?? 0;
  const probeWarning = probes?.filter((probe) => probe.status === "warning").length ?? 0;
  const probeSummary = probes
    ? {
        total: probes.length,
        healthy: probes.length - probeDown - probeWarning,
        warning: probeWarning,
        down: probeDown,
      }
    : undefined;

  return NextResponse.json(
    {
      status,
      checked_at: new Date().toISOString(),
      summary: {
        total: capabilities.length,
        healthy,
        degraded,
        down,
        disabled,
      },
      capabilities,
      ...(probes ? { probes, probe_summary: probeSummary } : {}),
    },
    { status: requiredDown ? 503 : 200 },
  );
}
