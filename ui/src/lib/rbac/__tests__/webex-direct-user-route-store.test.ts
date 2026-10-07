const updateOne = jest.fn(async () => ({ upsertedCount: 1 }));
const deleteOne = jest.fn(async () => ({ deletedCount: 1 }));
const toArray = jest.fn(async () => []);
const sort = jest.fn(() => ({ toArray }));
const find = jest.fn(() => ({ sort, toArray }));

jest.mock("../mongo-collections", () => ({
  getRbacCollection: jest.fn(async () => ({
    updateOne,
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
