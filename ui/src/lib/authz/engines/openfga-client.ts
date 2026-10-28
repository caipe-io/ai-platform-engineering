import { bundledAuthorizationModel, installedAuthorizationModules } from "@/native-extensions/authorization.generated";
import { authorizationModelsEqual } from "../../../../app-sdk/authorization-model.mjs";
import { getCurrentTraceparent } from "@/lib/rbac/authz-tracing";

// Private BFF transport shared by CAS and the RBAC relationship helpers.
// Policy, decision caching and write compensation belong to the callers.
let storeIdPromise: Promise<string> | null = null;
let cachedStoreId: string | null = null;
let selected: { key: string; id?: string; promise: Promise<string> } | undefined;
const MODEL_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const selectionKey = () => `${process.env.OPENFGA_HTTP}|${process.env.OPENFGA_STORE_ID || process.env.OPENFGA_STORE_NAME}|${process.env.OPENFGA_AUTHORIZATION_MODEL_ID}`;

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
  selected = undefined;
}

/** The native service contract never follows an implicitly latest model. */
export function getOpenFgaModelId(): string | undefined {
  const id = process.env.OPENFGA_AUTHORIZATION_MODEL_ID?.trim();
  if (id && !MODEL_ID_PATTERN.test(id)) throw new Error("Invalid OPENFGA_AUTHORIZATION_MODEL_ID");
  const resolved = id || (selected?.key === selectionKey() ? selected.id : undefined);
  return resolved;
}

/** Resolve the exact build artifact once; never activate an implicitly latest model. */
export async function resolveOpenFgaModelId(): Promise<string | undefined> {
  const explicit = process.env.OPENFGA_AUTHORIZATION_MODEL_ID?.trim();
  if (!installedAuthorizationModules.length) return getOpenFgaModelId();
  const key = selectionKey();
  if (selected?.key !== key) {
    const promise = (async () => {
      const storeId = await getOpenFgaStoreId();
      const signal = AbortSignal.timeout(OPENFGA_READ_TIMEOUT_MS);
      if (explicit) {
        getOpenFgaModelId(); // Validate the configured ID syntax.
        const response = await requestOpenFga(`/stores/${storeId}/authorization-models/${explicit}`, { method: "GET", signal });
        if (!response.ok) throw new Error("Selected bundled model is unavailable");
        const body = await response.json() as { authorization_model?: unknown };
        if (!body.authorization_model || !authorizationModelsEqual(body.authorization_model, bundledAuthorizationModel)) {
          throw new Error("Selected model does not match the host build");
        }
        return explicit;
      }
      let token = "";
      do {
        const response = await requestOpenFga(`/stores/${storeId}/authorization-models?page_size=100${token ? `&continuation_token=${encodeURIComponent(token)}` : ""}`, { method: "GET", signal });
        if (!response.ok) throw new Error("Compiled model lookup failed");
        const page = await response.json() as { authorization_models?: Array<{ id: string }>; continuation_token?: string };
        const match = page.authorization_models?.find((candidate) => authorizationModelsEqual(candidate, bundledAuthorizationModel));
        if (match) {
          if (!MODEL_ID_PATTERN.test(match.id ?? "")) throw new Error("Compiled model lookup returned an invalid model ID");
          return match.id;
        }
        token = page.continuation_token ?? "";
      } while (token);
      throw new Error("The authorization model bundled in this host build has not been published");
    })();
    selected = { key, promise };
    promise.then((id) => { if (selected?.promise === promise) selected.id = id; },
      () => { if (selected?.promise === promise) selected = undefined; });
  }
  return selected!.promise;
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
  const modelDependent = /\/(check|batch-check|list-objects|list-users|expand|write)$/.test(path);
  const modelId = modelDependent && options.method === "POST" && installedAuthorizationModules.length
    ? await resolveOpenFgaModelId() : getOpenFgaModelId();
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
