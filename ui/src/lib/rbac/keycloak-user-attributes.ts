export function userAttributes(user: Record<string, unknown>): Record<string, unknown> {
  const value = user.attributes;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function firstAttribute(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim() ? first.trim() : undefined;
}
