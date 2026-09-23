jest.mock("next/server", () => ({
  NextRequest: class NextRequest {},
  NextResponse: class NextResponse {},
}));

import { ApiError } from "@/lib/api-error";
import {
  platformActor,
  platformResourceRevision,
  platformResourceView,
  validatePlatformChangeInput,
} from "@/lib/platform-changes.server";

describe("platform change safety boundary", () => {
  it("accepts a narrow prompt update", () => {
    expect(validatePlatformChangeInput({
      kind: "agent",
      operation: "update",
      resource_id: "agent-example",
      changes: { system_prompt: "Answer with concise operational guidance." },
      reason: "The owner asked for shorter answers.",
    })).toEqual({
      kind: "agent",
      operation: "update",
      resourceId: "agent-example",
      changes: { system_prompt: "Answer with concise operational guidance." },
      reason: "The owner asked for shorter answers.",
    });
  });

  it.each(["owner_id", "owner_team_slug", "visibility", "shared_with_teams", "credential_sources"])(
    "rejects control-plane authority field %s",
    (field) => {
      expect(() => validatePlatformChangeInput({
        kind: "agent",
        operation: "update",
        resource_id: "agent-example",
        changes: { [field]: "unauthorized" },
        reason: "Attempt to expand authority.",
      })).toThrow(ApiError);
    },
  );

  it("keeps agent owner-team selection in the canonical admin UI", () => {
    expect(() => validatePlatformChangeInput({
      kind: "agent",
      operation: "create",
      changes: {
        name: "Example Agent",
        system_prompt: "Help with examples.",
        model: { id: "example-model", provider: "example-provider" },
      },
      reason: "Create an agent.",
    })).toThrow("owner-team selection");
  });

  it("requires a human actor", () => {
    expect(() => platformActor(
      { email: "automation@example.com" },
      { sub: "service-subject", isServiceAccount: true },
    )).toThrow("human user identity");
  });

  it("uses only mutable fields for conflict revisions", () => {
    const first = platformResourceRevision("agent", {
      _id: "agent-example",
      owner_id: "owner@example.com",
      updated_at: new Date("2026-01-01T00:00:00Z"),
      system_prompt: "Be helpful.",
      allowed_tools: { example: ["read"] },
    });
    const metadataOnly = platformResourceRevision("agent", {
      _id: "agent-example",
      owner_id: "different@example.com",
      updated_at: new Date("2026-02-01T00:00:00Z"),
      system_prompt: "Be helpful.",
      allowed_tools: { example: ["read"] },
    });
    const contentChanged = platformResourceRevision("agent", {
      _id: "agent-example",
      system_prompt: "Be precise.",
      allowed_tools: { example: ["read"] },
    });

    expect(metadataOnly).toBe(first);
    expect(contentChanged).not.toBe(first);
  });

  it("does not expose authority fields in an inspection view", () => {
    expect(platformResourceView("agent", {
      _id: "agent-example",
      owner_id: "owner@example.com",
      owner_team_slug: "primary",
      system_prompt: "Be helpful.",
      allowed_tools: { example: ["read"] },
    })).toEqual({
      system_prompt: "Be helpful.",
      allowed_tools: { example: ["read"] },
    });
  });
});
