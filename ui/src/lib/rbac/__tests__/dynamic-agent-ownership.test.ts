/**
 * Unit tests for the dynamic-agent ownership normalization helpers.
 */

import {
  coerceAgentVisibilityOnRead,
  normalizeLegacyVisibility,
  resolveOwnerTeamSlug,
  validateAgentOwnership,
} from "../dynamic-agent-ownership";
import type { VisibilityType } from "@/types/dynamic-agent";

describe("normalizeLegacyVisibility", () => {
  it("passes 'private' through as a supported visibility", () => {
    expect(normalizeLegacyVisibility("private")).toEqual({
      value: "private",
      deprecated: false,
      coercedFromInvalid: false,
    });
  });

  it("passes 'team' through untouched", () => {
    expect(normalizeLegacyVisibility("team")).toEqual({
      value: "team",
      deprecated: false,
      coercedFromInvalid: false,
    });
  });

  it("passes 'global' through untouched", () => {
    expect(normalizeLegacyVisibility("global")).toEqual({
      value: "global",
      deprecated: false,
      coercedFromInvalid: false,
    });
  });

  it("defaults unknown strings to 'team' and flags as coerced", () => {
    expect(normalizeLegacyVisibility("whatever")).toEqual({
      value: "team",
      deprecated: false,
      coercedFromInvalid: true,
    });
  });

  it("defaults missing/non-string to 'team' and flags as coerced", () => {
    expect(normalizeLegacyVisibility(undefined)).toEqual({
      value: "team",
      deprecated: false,
      coercedFromInvalid: true,
    });
  });
});

describe("coerceAgentVisibilityOnRead", () => {
  it("preserves a private Mongo doc", () => {
    const doc = { _id: "agent-foo", visibility: "private" } as Record<string, unknown>;
    const out = coerceAgentVisibilityOnRead(doc);
    expect(out.visibility).toBe("private");
    expect(out).toBe(doc); // mutates in place and returns the same reference
  });

  it("is a no-op for current values", () => {
    const doc = { _id: "agent-foo", visibility: "team" } as Record<string, unknown>;
    coerceAgentVisibilityOnRead(doc);
    expect(doc.visibility).toBe("team");

    const doc2 = { _id: "agent-bar", visibility: "global" } as Record<string, unknown>;
    coerceAgentVisibilityOnRead(doc2);
    expect(doc2.visibility).toBe("global");
  });
});

describe("validateAgentOwnership", () => {
  it("accepts visibility=team with an owner_team_slug", () => {
    expect(
      validateAgentOwnership({
        visibility: "team",
        ownerTeamSlug: "platform",
        ownerTeamId: "507f1f77bcf86cd799439011",
      }),
    ).toEqual({ ok: true });
  });

  it("accepts visibility=global with an owner_team_slug", () => {
    expect(
      validateAgentOwnership({
        visibility: "global",
        ownerTeamSlug: "platform",
        ownerTeamId: undefined,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects missing owner_team_slug with OWNER_TEAM_REQUIRED", () => {
    const result = validateAgentOwnership({
      visibility: "team",
      ownerTeamSlug: null,
      ownerTeamId: null,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("OWNER_TEAM_REQUIRED");
    expect(result.message).toMatch(/owned by a team/i);
  });

  it("rejects blank owner_team_slug with OWNER_TEAM_REQUIRED", () => {
    expect(
      validateAgentOwnership({
        visibility: "team",
        ownerTeamSlug: "   ",
        ownerTeamId: "anything",
      }).code,
    ).toBe("OWNER_TEAM_REQUIRED");
  });

  it("accepts private visibility without an owner team", () => {
    const result = validateAgentOwnership({
      visibility: "private" as unknown as VisibilityType,
      ownerTeamSlug: null,
      ownerTeamId: null,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("resolveOwnerTeamSlug", () => {
  it("prefers the body value when present", () => {
    expect(
      resolveOwnerTeamSlug({ owner_team_slug: "platform" }, { owner_team_slug: "old" }),
    ).toBe("platform");
  });

  it("falls back to the existing doc when the body omits owner_team_slug", () => {
    expect(resolveOwnerTeamSlug({}, { owner_team_slug: "platform" })).toBe("platform");
  });

  it("returns null when neither the body nor the existing doc carry a slug", () => {
    expect(resolveOwnerTeamSlug({}, null)).toBeNull();
    expect(resolveOwnerTeamSlug({ owner_team_slug: "   " }, { owner_team_slug: undefined })).toBeNull();
  });

  it("trims body values before returning", () => {
    expect(resolveOwnerTeamSlug({ owner_team_slug: "  platform  " }, null)).toBe("platform");
  });
});
