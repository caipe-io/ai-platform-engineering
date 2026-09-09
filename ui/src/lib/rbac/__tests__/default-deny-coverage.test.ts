/**
 * Default-deny coverage backstop (spec 2026-06-04-fga-coverage-guarantee, Layer 4).
 *
 * The strongest single guarantee: a freshly-authenticated subject with NO tuples
 * is denied read/use/manage on EVERY registered resource type. The test is
 * parametrized over the live registry, so a newly-added type is automatically
 * covered and fails until enforcement (and grants) exist. It also pins the unsafe
 * RBAC bypass OFF by default and verifies the org-admin bypass does not fire for a
 * non-admin subject.
 *
 * assisted-by Cursor claude-opus-4.8
 */

jest.mock("@/lib/authz", () => ({
  authorize: jest.fn(),
  authorizeMany: jest.fn(),
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: jest.fn(),
}));

import { requireResourcePermission } from "../resource-authz";
import { UNIVERSAL_REBAC_RESOURCE_TYPES } from "../resource-model";
import { isUnsafeRbacBypassEnabled } from "../bypass";
import type { OpenFgaCheckResult } from "../openfga";
import type { ResourcePermissionAction } from "../resource-authz";

const registryTypes = UNIVERSAL_REBAC_RESOURCE_TYPES.map((d) => d.type);

/** Simulates an OpenFGA store with NO tuples for this subject — everything denied. */
const denyAll = async (): Promise<OpenFgaCheckResult> => ({
  allowed: false,
});

const session = { sub: "no-grants-subject", user: { email: "nobody@example.com" } };
const ACTIONS: ResourcePermissionAction[] = ["read", "use", "manage"];

describe("default-deny coverage", () => {
  it("the unsafe RBAC bypass is OFF by default", () => {
    delete process.env.CAIPE_UNSAFE_RBAC_BYPASS;
    expect(isUnsafeRbacBypassEnabled()).toBe(false);
  });

  describe.each(registryTypes)("resource type %s", (type) => {
    it.each(ACTIONS)("denies %s for a subject with no tuples", async (action) => {
      await expect(
        requireResourcePermission(session, { type, id: "any-id", action }, { check: denyAll }),
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it("does not allow via the org-admin bypass when the subject is not an org admin", async () => {
      await expect(
        requireResourcePermission(
          session,
          { type, id: "any-id", action: "manage" },
          { check: denyAll, bypassForOrgAdmin: true },
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  it("requires a stable subject (no anonymous default-allow)", async () => {
    await expect(
      requireResourcePermission(
        { user: { email: "x@example.com" } },
        { type: "agent", id: "any", action: "read" },
        { check: denyAll },
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});
