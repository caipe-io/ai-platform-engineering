import { createHash } from "node:crypto";

import { NextRequest,NextResponse } from "next/server";

interface CachedJsonResponse {
  body: unknown;
  status: number;
  expiresAt: number;
}

interface ComputedJsonResponse {
  body: unknown;
  status: number;
}

export interface JsonResponseCacheStore {
  responses: Map<string, CachedJsonResponse>;
  inflight: Map<string, Promise<ComputedJsonResponse | NextResponse>>;
}

export interface JsonResponseCacheOptions {
  ttlMs: number;
  keyParts?: Array<string | number | boolean | null | undefined>;
  varyHeaders?: string[];
  cacheableStatus?: (status: number) => boolean;
  maxEntries?: number;
}

export function createJsonResponseCacheStore(): JsonResponseCacheStore {
  return {
    responses: new Map(),
    inflight: new Map(),
  };
}

function stableHeaderHash(request: NextRequest, headers: string[]): string {
  const hash = createHash("sha256");
  for (const header of headers) {
    hash.update(header.toLowerCase());
    hash.update("\0");
    hash.update(request.headers.get(header) ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function buildCacheKey(request: NextRequest, options: JsonResponseCacheOptions): string {
  const varyHeaders = options.varyHeaders ?? ["authorization", "cookie"];
  return JSON.stringify({
    method: request.method,
    url: request.url,
    keyParts: options.keyParts ?? [],
    vary: stableHeaderHash(request, varyHeaders),
  });
}

function pruneExpired(store: JsonResponseCacheStore, now: number): void {
  for (const [key, entry] of store.responses) {
    if (entry.expiresAt <= now) {
      store.responses.delete(key);
    }
  }
}

function pruneToMaxEntries(store: JsonResponseCacheStore, maxEntries: number): void {
  while (store.responses.size > maxEntries) {
    const oldestKey = store.responses.keys().next().value as string | undefined;
    if (!oldestKey) return;
    store.responses.delete(oldestKey);
  }
}

function jsonResponse(entry: ComputedJsonResponse, cacheState: "hit" | "shared" | "miss"): NextResponse {
  return NextResponse.json(entry.body, {
    status: entry.status,
    headers: {
      "x-caipe-cache": cacheState,
    },
  });
}

export async function withJsonResponseCache(
  request: NextRequest,
  store: JsonResponseCacheStore,
  compute: () => Promise<NextResponse>,
  options: JsonResponseCacheOptions,
): Promise<NextResponse> {
  if (options.ttlMs <= 0 || request.nextUrl.searchParams.get("refresh") === "true") {
    return compute();
  }

  const now = Date.now();
  pruneExpired(store, now);

  const key = buildCacheKey(request, options);
  const cached = store.responses.get(key);
  if (cached && cached.expiresAt > now) {
    return jsonResponse(cached, "hit");
  }

  const shared = store.inflight.get(key);
  if (shared) {
    const entry = await shared;
    return entry instanceof NextResponse ? entry.clone() as NextResponse : jsonResponse(entry, "shared");
  }

  // Keep one upstream computation per cache key under load; callers waiting on
  // the promise receive a fresh JSON response built from the same computed body.
  const promise = (async (): Promise<ComputedJsonResponse | NextResponse> => {
    const response = await compute();
    const cacheableStatus = options.cacheableStatus ?? ((status: number) => status >= 200 && status < 300);
    if (!cacheableStatus(response.status)) {
      return response;
    }

    let body: unknown;
    try {
      body = await response.clone().json();
    } catch {
      return response;
    }

    const entry = {
      body,
      status: response.status,
    };
    store.responses.set(key, {
      ...entry,
      expiresAt: Date.now() + options.ttlMs,
    });
    pruneToMaxEntries(store, options.maxEntries ?? 256);
    return entry;
  })();

  store.inflight.set(key, promise);
  try {
    const entry = await promise;
    return entry instanceof NextResponse ? entry.clone() as NextResponse : jsonResponse(entry, "miss");
  } finally {
    store.inflight.delete(key);
  }
}

export function envTtlMs(name: string, defaultMs: number): number {
  const raw = process.env[name];
  if (!raw && process.env.NODE_ENV === "test") return 0;
  if (!raw) return defaultMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultMs;
}
