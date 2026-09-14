/**
 * Shared identity-parsing primitives for the superadmin RAG admin tools
 * that assign an Owner and/or Search Access directly on datasources -
 * app-config source adoption and bulk collection-permission application.
 */

import { getCollection } from "@/lib/mongodb";

export const OPENFGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;

export function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

export function isValidTeamSlug(value: string): boolean {
  return OPENFGA_ID_PATTERN.test(value);
}

export async function loadOwnerTeam(
  slug: string,
): Promise<{ slug: string } | null> {
  const teams = await getCollection<{ slug: string }>("teams");
  return teams.findOne({ slug } as never);
}
