const SENSITIVE_DETAIL_KEY_PATTERN = /(secret|token|password|credential|plaintext|privateKey)/i;

export function maskCredentialValue(value: string): string {
  if (value.length === 0) {
    return "";
  }
  if (value.length === 1) {
    return "*";
  }
  if (value.length <= 4) {
    return `${value.slice(0, 1)}${"*".repeat(value.length - 1)}`;
  }
  if (value.length <= 8) {
    return `${value.slice(0, 1)}...${value.slice(-1)}`;
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/**
 * Display form of a masked hint, keeping only its trailing characters.
 *
 * Enough to tell two credentials apart without repeating any of the leading
 * characters that `maskCredentialValue` retains for storage.
 */
export function shortMaskedPreview(maskedPreview: string | undefined | null): string | null {
  const tail = maskedPreview?.trim().slice(-3);
  return tail ? `...${tail}` : null;
}

export function isOpaqueMaskedPreview(value: string): boolean {
  return value.length > 1 && /^\*+$/.test(value);
}

export function redactCredentialDetails<T extends Record<string, unknown>>(details: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      SENSITIVE_DETAIL_KEY_PATTERN.test(key) ? "[redacted]" : value,
    ]),
  );
}
