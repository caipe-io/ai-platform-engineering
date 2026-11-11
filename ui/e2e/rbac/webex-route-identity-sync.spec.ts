import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

import { getRbacCollection } from "../../src/lib/rbac/mongo-collections";
import {
  setWebexIdentityForUserRoutes,
  type WebexDirectUserRouteDocument,
} from "../../src/lib/rbac/webex-direct-user-route-store";

// Uses the same disposable MongoDB as the session-backed regression lane.
// No provider APIs, authorization services, or live bot messages are involved.
test.describe("Webex route identity persistence", () => {
  test.skip(
    process.env.RUN_RBAC_REGRESSION !== "1" || !process.env.MONGODB_URI || !process.env.MONGODB_DATABASE,
    "Requires the isolated MongoDB-backed regression harness.",
  );

  test("link, repeat, relink and unlink preserve existing routes across bots", async () => {
    const userId = `test-user-${randomUUID()}`;
    const otherUserId = `test-user-${randomUUID()}`;
    const subjects = [userId, otherUserId];
    const collection = await getRbacCollection<WebexDirectUserRouteDocument>("webexDirectUserRoutes");
    const common = {
      user_email: "test-user@example.com", created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z", created_by: "test-admin", updated_by: "test-admin",
    };
    try {
      await collection.insertMany([
        { ...common, keycloak_user_id: userId, bot_id: "primary", agent_id: "primary-agent", status: "active" },
        { ...common, keycloak_user_id: userId, bot_id: "secondary", agent_id: "secondary-agent", status: "disabled", webex_user_id: "previous-person" },
        { ...common, keycloak_user_id: otherUserId, bot_id: "primary", agent_id: "other-agent", status: "active", webex_user_id: "other-person" },
      ]);
      const before = await collection.find({ keycloak_user_id: { $in: subjects } }).toArray();

      for (const personId of ["test-person", "test-person", "replacement-person", null]) {
        await setWebexIdentityForUserRoutes(userId, personId);
        const after = await collection.find({ keycloak_user_id: { $in: subjects } }).toArray();
        expect(after).toHaveLength(before.length);
        for (const original of before) {
          const expected = { ...original };
          if (original.keycloak_user_id === userId) {
            expected.updated_at = expect.any(String);
            if (personId === null) delete expected.webex_user_id;
            else expected.webex_user_id = personId;
          }
          expect(after.find((route) => route._id.equals(original._id))).toEqual(expected);
        }
      }
    } finally {
      await collection.deleteMany({ keycloak_user_id: { $in: subjects } });
    }
  });

  test("linking an identity does not create a direct-message route", async () => {
    const userId = `test-user-${randomUUID()}`;
    const collection = await getRbacCollection<WebexDirectUserRouteDocument>("webexDirectUserRoutes");
    try {
      await setWebexIdentityForUserRoutes(userId, "test-person");
      expect(await collection.countDocuments({ keycloak_user_id: userId })).toBe(0);
    } finally {
      await collection.deleteMany({ keycloak_user_id: userId });
    }
  });
});
