import { getCurrentTraceparent } from "@/lib/rbac/authz-tracing";

// Private BFF transport shared by CAS and the RBAC relationship helpers.
// Policy, decision caching and write compensation belong to the callers.
let storeIdPromise: Promise<string> | null = null;
let cachedStoreId: string | null = null;

// Bound discovery and fresh execution checks without replaying failed requests.
export const OPENFGA_READ_TIMEOUT_MS = 5_000;

export function isOpenFgaConfigured(): boolean {
  return Boolean(process.env.OPENFGA_HTTP?.trim());
}

export function getCachedOpenFgaStoreId(): string | null {
  return process.env.OPENFGA_STORE_ID?.trim() || cachedStoreId;
}

export function resetOpenFgaStoreIdCacheForTests(): void {
  if (process.env.NODE_ENV === "test") invalidateStoreId();
}

function invalidateStoreId(): void {
  storeIdPromise = null;
  cachedStoreId = null;
}

/** The native service contract never follows an implicitly latest model. */
export function getOpenFgaModelId(required = false): string | undefined {
  const id = process.env.OPENFGA_AUTHORIZATION_MODEL_ID?.trim();
  if (id && !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new Error("Invalid OPENFGA_AUTHORIZATION_MODEL_ID");
  if (required && (!id || !process.env.OPENFGA_STORE_ID?.trim())) {
    throw new Error("Native service resources require explicit OpenFGA store and model IDs");
  }
  return id;
}

export async function requestOpenFga(
  path: `/stores${string}`,
  options: { method: "GET" | "POST"; body?: string; signal?: AbortSignal },
): Promise<Response> {
  const baseUrl = process.env.OPENFGA_HTTP?.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("OPENFGA_HTTP is not set");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const traceparent = getCurrentTraceparent();
  if (traceparent) headers.traceparent = traceparent;
  // Pin in the single transport so checks, batch checks, lists and writes cannot drift.
  const modelId = getOpenFgaModelId();
  const modelDependent = /\/(check|batch-check|list-objects|list-users|expand|write)$/.test(path);
  let body = options.body;
  if (modelId && modelDependent && options.method === "POST") {
    const payload = JSON.parse(body ?? "{}");
    if (payload.authorization_model_id && payload.authorization_model_id !== modelId) {
      throw new Error("OpenFGA request conflicts with the selected authorization model");
    }
    body = JSON.stringify({ ...payload, authorization_model_id: modelId });
  }
  const response = await fetch(`${baseUrl}${path}`, { ...options, body, headers });
  // Forget a stale discovered store, but never automatically replay a write.
  if (response.status === 404) invalidateStoreId();
  return response;
}

export async function getOpenFgaStoreId(): Promise<string> {
  const explicit = process.env.OPENFGA_STORE_ID?.trim();
  if (explicit) return explicit;
  if (!storeIdPromise) {
    const storeName = process.env.OPENFGA_STORE_NAME?.trim() || "caipe-openfga";
    storeIdPromise = requestOpenFga("/stores", {
      method: "GET",
      signal: AbortSignal.timeout(OPENFGA_READ_TIMEOUT_MS),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`OpenFGA store discovery failed: ${response.status}`);
        const body = (await response.json()) as { stores?: Array<{ id?: string; name?: string }> };
        const store = body.stores?.find((candidate) => candidate.name === storeName);
        if (!store?.id) throw new Error(`OpenFGA store ${storeName} was not found`);
        cachedStoreId = store.id;
        return store.id;
      })
      .catch((error: unknown) => {
        invalidateStoreId();
        throw error;
      });
  }
  return storeIdPromise;
}
