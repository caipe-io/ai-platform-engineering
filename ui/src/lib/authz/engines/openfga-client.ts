import { getCurrentTraceparent } from "@/lib/rbac/authz-tracing";

// Private BFF transport shared by CAS and the RBAC relationship helpers.
// Policy, decision caching and write compensation belong to the callers.
let storeIdPromise: Promise<string> | null = null;
let cachedStoreId: string | null = null;

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

export async function requestOpenFga(
  path: `/stores${string}`,
  options: { method: "GET" | "POST"; body?: string },
): Promise<Response> {
  const baseUrl = process.env.OPENFGA_HTTP?.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("OPENFGA_HTTP is not set");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const traceparent = getCurrentTraceparent();
  if (traceparent) headers.traceparent = traceparent;
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  // Forget a stale discovered store, but never automatically replay a write.
  if (response.status === 404) invalidateStoreId();
  return response;
}

export async function getOpenFgaStoreId(): Promise<string> {
  const explicit = process.env.OPENFGA_STORE_ID?.trim();
  if (explicit) return explicit;
  if (!storeIdPromise) {
    const storeName = process.env.OPENFGA_STORE_NAME?.trim() || "caipe-openfga";
    storeIdPromise = requestOpenFga("/stores", { method: "GET" })
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
