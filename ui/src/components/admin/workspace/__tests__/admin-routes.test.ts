import {
  ADMIN_CATEGORIES,
  ADMIN_DESTINATIONS,
  DEFAULT_ADMIN_DESTINATION_ID,
  DEFAULT_READONLY_DESTINATION_ID,
  filterAdminCategories,
  findAdminDestinationByPath,
} from "../admin-routes";

describe("admin route registry", () => {
  it("defines scoped task-oriented categories without an ambiguous Settings category", () => {
    expect(ADMIN_CATEGORIES.map((category) => category.label)).toEqual([
      "Teams & Users",
      "Platform configuration",
      "Resources",
      "Integrations",
      "Insights",
      "Metrics & Health",
      "Security & Policy",
    ]);
    expect(ADMIN_CATEGORIES.some((category) => category.label === "Settings")).toBe(false);
  });

  it("uses canonical paths as the only destination lookup contract", () => {
    expect(findAdminDestinationByPath("/admin/platform/agents")?.id).toBe("agents");
    expect(findAdminDestinationByPath("/admin/platform/mcp-catalog")?.id).toBe("mcp");
    expect(findAdminDestinationByPath("/admin/security/autonomous-enablement")?.id).toBe(
      "autonomous",
    );
    expect(findAdminDestinationByPath("/admin/security/ai-review/")?.id).toBe("ai-review");
    expect(findAdminDestinationByPath("/admin/configuration/defaults")?.id).toBe("defaults");
    expect(findAdminDestinationByPath("/admin/configuration/announcements")?.id).toBe("announcements");
    expect(findAdminDestinationByPath("/admin/platform/defaults")).toBeUndefined();
    expect(findAdminDestinationByPath("/admin/platform/autonomous")).toBeUndefined();
  });

  it("filters destinations by access and removes empty categories", () => {
    const gates = Object.fromEntries(
      [...new Set(ADMIN_DESTINATIONS.map((destination) => destination.gateKey))].map(
        (gateKey) => [gateKey, false],
      ),
    );
    gates.users = true;
    gates.health = true;

    const categories = filterAdminCategories(gates);

    expect(categories.map((category) => category.id)).toEqual(["people", "operations"]);
    expect(categories[0].destinations.map((destination) => destination.id)).toEqual(["users"]);
    expect(categories[1].destinations.map((destination) => destination.id)).toEqual(["health"]);
  });

  it("keeps deterministic defaults for admins and read-only viewers", () => {
    expect(DEFAULT_ADMIN_DESTINATION_ID).toBe("users");
    expect(DEFAULT_READONLY_DESTINATION_ID).toBe("users");
  });
});
