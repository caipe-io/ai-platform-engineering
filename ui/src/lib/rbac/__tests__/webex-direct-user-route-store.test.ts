const updateOne = jest.fn(async () => ({ upsertedCount: 1 }));
const updateMany = jest.fn(async () => ({ matchedCount: 2 }));
const deleteOne = jest.fn(async () => ({ deletedCount: 1 }));
const toArray = jest.fn(async () => []);
const sort = jest.fn(() => ({ toArray }));
const find = jest.fn(() => ({ sort, toArray }));

jest.mock("../mongo-collections", () => ({
  getRbacCollection: jest.fn(async () => ({
    updateOne,
    updateMany,
    deleteOne,
    find,
  })),
}));

import {
  deleteWebexDirectUserRoute,
  listWebexDirectUserRoutes,
  listWebexDirectUserRoutesByUserIds,
  listWebexDirectUserRoutesForUser,
  upsertWebexDirectUserRoute,
  setWebexIdentityForUserRoutes,
} from "../webex-direct-user-route-store";

describe("Webex direct-user route ownership", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses independent resource keys for the same user on different bots", async () => {
    const common = {
      keycloakUserId: "user-1",
      userEmail: "user@example.com",
      agentId: "agent-1",
      actor: "admin@example.com",
      enabled: true,
    };

    await upsertWebexDirectUserRoute({ ...common, botId: "primary" });
    await upsertWebexDirectUserRoute({ ...common, botId: "secondary" });

    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(updateOne.mock.calls[0][0]).toEqual({ _id: '["primary","user-1"]' });
    expect(updateOne.mock.calls[1][0]).toEqual({ _id: '["secondary","user-1"]' });
    expect(updateOne.mock.calls[0][1].$set.bot_id).toBe("primary");
    expect(updateOne.mock.calls[1][1].$set.bot_id).toBe("secondary");
  });

  it("lists routes for only the selected bot", async () => {
    await listWebexDirectUserRoutes("primary");

    expect(find).toHaveBeenCalledWith({ bot_id: "primary" });
  });

  it("deletes only the selected bot route for a user", async () => {
    await deleteWebexDirectUserRoute("secondary", "user-1");

    expect(deleteOne).toHaveBeenCalledWith({
      _id: '["secondary","user-1"]',
    });
  });

  it("lists a user's routes across bots, keyed by bot_id", async () => {
    toArray.mockResolvedValueOnce([
      { bot_id: "primary", keycloak_user_id: "user-1", agent_id: "agent-1" },
      { bot_id: "secondary", keycloak_user_id: "user-1", agent_id: "agent-2" },
    ]);

    const routes = await listWebexDirectUserRoutesForUser("user-1");

    expect(find).toHaveBeenCalledWith({ keycloak_user_id: "user-1" });
    expect(routes.get("primary")?.agent_id).toBe("agent-1");
    expect(routes.get("secondary")?.agent_id).toBe("agent-2");
  });

  it("lists routes for one bot scoped to a set of user ids, keyed by keycloak_user_id", async () => {
    toArray.mockResolvedValueOnce([
      { bot_id: "primary", keycloak_user_id: "user-1", agent_id: "agent-1" },
      { bot_id: "primary", keycloak_user_id: "user-2", agent_id: "agent-2" },
    ]);

    const routes = await listWebexDirectUserRoutesByUserIds("primary", ["user-1", "user-2"]);

    expect(find).toHaveBeenCalledWith({
      bot_id: "primary",
      keycloak_user_id: { $in: ["user-1", "user-2"] },
    });
    expect(routes.get("user-1")?.agent_id).toBe("agent-1");
    expect(routes.get("user-2")?.agent_id).toBe("agent-2");
  });

  it("short-circuits on an empty user id list without querying Mongo", async () => {
    const routes = await listWebexDirectUserRoutesByUserIds("primary", []);

    expect(routes.size).toBe(0);
    expect(find).not.toHaveBeenCalled();
  });
});


describe("Webex route identity synchronization", () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(["person-1", "person-2"])("binds %s across bots and disabled routes without changing grants", async (personId) => {
    await setWebexIdentityForUserRoutes(" user-1 ", ` ${personId} `);

    // No bot/status filter: all existing routes for this subject are updated.
    // No upsert or grant/agent/status fields: no route or access is created.
    expect(updateMany).toHaveBeenCalledWith(
      { keycloak_user_id: "user-1" },
      { $set: { webex_user_id: personId, updated_at: expect.any(String) } },
    );
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("supports repeated linking and relinking without creating routes", async () => {
    for (const personId of ["person-1", "person-1", "person-2"]) {
      await setWebexIdentityForUserRoutes("user-1", personId);
    }
    expect(updateMany).toHaveBeenCalledTimes(3);
    expect(updateMany.mock.calls.map((call) => call[1].$set.webex_user_id)).toEqual(["person-1", "person-1", "person-2"]);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("unlinks only identity fields on the selected user's existing routes", async () => {
    await setWebexIdentityForUserRoutes("user-1", null);
    expect(updateMany).toHaveBeenCalledWith(
      { keycloak_user_id: "user-1" },
      { $unset: { webex_user_id: "" }, $set: { updated_at: expect.any(String) } },
    );
    expect(deleteOne).not.toHaveBeenCalled();
  });

  it("does not create a route when the user has none", async () => {
    updateMany.mockResolvedValueOnce({ matchedCount: 0 });
    await setWebexIdentityForUserRoutes("user-without-routes", "person-1");
    expect(updateMany).toHaveBeenCalledWith(
      { keycloak_user_id: "user-without-routes" },
      { $set: { webex_user_id: "person-1", updated_at: expect.any(String) } },
    );
    expect(updateOne).not.toHaveBeenCalled();
  });

  it.each([["", "person-1"], ["user-1", ""], ["user-1", "invalid/id"]])("rejects invalid identifiers (%s, %s)", async (userId, personId) => {
    await expect(setWebexIdentityForUserRoutes(userId, personId)).rejects.toThrow("is invalid");
    expect(updateMany).not.toHaveBeenCalled();
  });
});
