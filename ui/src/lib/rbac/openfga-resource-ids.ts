import type { UniversalRebacResourceType } from "@/types/rbac-universal";

const OPENFGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "===".slice((padded.length + 3) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function isOpenFgaSafeObjectId(value: string): boolean {
  return OPENFGA_ID_PATTERN.test(value) && !value.includes(":") && !value.includes("#");
}

export function openFgaResourceId(type: UniversalRebacResourceType, id: string): string {
  if (type !== "llm_model" || isOpenFgaSafeObjectId(id)) {
    return id;
  }
  return `b64_${base64UrlEncode(id)}`;
}

export function openFgaResourceObject(type: UniversalRebacResourceType, id: string): string {
  return `${type}:${openFgaResourceId(type, id)}`;
}

/** Inverse of {@link openFgaResourceId} — undoes the `b64_` encoding for `list-objects` results. */
export function parseOpenFgaResourceId(fgaId: string): string {
  if (!fgaId.startsWith("b64_")) return fgaId;
  try {
    return base64UrlDecode(fgaId.slice("b64_".length));
  } catch {
    return fgaId;
  }
}

/** Strips the `type:` prefix OpenFGA's `list-objects` returns and undoes id encoding. */
export function parseOpenFgaObject(fgaObject: string): string {
  const separatorIndex = fgaObject.indexOf(":");
  const rawId = separatorIndex === -1 ? fgaObject : fgaObject.slice(separatorIndex + 1);
  return parseOpenFgaResourceId(rawId);
}
