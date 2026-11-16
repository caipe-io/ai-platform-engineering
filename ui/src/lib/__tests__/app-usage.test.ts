/** @jest-environment node */

const mockGetCollection = jest.fn();
let mockMongoConfigured = true;
jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  get isMongoDBConfigured() { return mockMongoConfigured; },
}));

describe("aggregate shell usage", () => {
  const originalEnabled = process.env.APP_USAGE_ENABLED;
  const createIndex = jest.fn();
  const updateOne = jest.fn();
  const toArray = jest.fn();
  const limit = jest.fn(() => ({ toArray }));
  const sort = jest.fn(() => ({ limit }));
  const find = jest.fn(() => ({ sort }));

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockMongoConfigured = true;
    process.env.APP_USAGE_ENABLED = "true";
    createIndex.mockResolvedValue("app_usage_daily_expiry");
    updateOne.mockResolvedValue({ matchedCount: 1 });
    toArray.mockResolvedValue([]);
    mockGetCollection.mockResolvedValue({ createIndex, updateOne, find });
  });
  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.APP_USAGE_ENABLED;
    else process.env.APP_USAGE_ENABLED = originalEnabled;
  });

  it("increments one UTC day with a fixed expiry and no identity fields", async () => {
    const { recordAppVisit } = await import("../app-usage");
    await recordAppVisit(new Date("2026-01-01T23:59:59Z"));
    await recordAppVisit(new Date("2026-01-01T00:00:00Z"));
    expect(createIndex).toHaveBeenCalledTimes(1);
    expect(createIndex).toHaveBeenCalledWith({ expires_at: 1 }, {
      name: "app_usage_daily_expiry", expireAfterSeconds: 0,
    });
    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(updateOne).toHaveBeenLastCalledWith({ _id: "2026-01-01" }, {
      $inc: { loads: 1 },
      $setOnInsert: { expires_at: new Date("2026-01-31T00:00:00Z") },
    }, { upsert: true });
    expect(mockGetCollection).toHaveBeenCalledWith("app_usage_daily");
  });

  it.each(["disabled", "mongo-unavailable", "invalid-date"])("does not write: %s", async (scenario) => {
    if (scenario === "disabled") delete process.env.APP_USAGE_ENABLED;
    if (scenario === "mongo-unavailable") mockMongoConfigured = false;
    const { recordAppVisit } = await import("../app-usage");
    await recordAppVisit(scenario === "invalid-date" ? new Date(NaN) : new Date());
    expect(mockGetCollection).not.toHaveBeenCalled();
  });

  it("fails closed on TTL initialization failure and retries on the next visit", async () => {
    createIndex.mockRejectedValueOnce(new Error("index unavailable"));
    const { recordAppVisit } = await import("../app-usage");
    await expect(recordAppVisit()).rejects.toThrow("index unavailable");
    expect(updateOne).not.toHaveBeenCalled();
    await recordAppVisit();
    expect(createIndex).toHaveBeenCalledTimes(2);
    expect(updateOne).toHaveBeenCalledTimes(1);
  });

  it("retries only the increment after a concurrent first-write collision", async () => {
    updateOne.mockRejectedValueOnce({ code: 11000 });
    const { recordAppVisit } = await import("../app-usage");
    await recordAppVisit(new Date("2026-01-01T00:00:00Z"));
    expect(updateOne).toHaveBeenLastCalledWith({ _id: "2026-01-01" }, { $inc: { loads: 1 } });
  });

  it("returns only unexpired daily counts within 30 UTC days", async () => {
    toArray.mockResolvedValue([{ _id: "2026-02-01", loads: 7 }, { _id: "2026-02-02", loads: 3 }]);
    const { readAppUsage } = await import("../app-usage");
    const now = new Date("2026-02-02T12:00:00Z");
    await expect(readAppUsage(now)).resolves.toEqual({
      enabled: true, retention_days: 30, total_loads: 10,
      daily: [{ date: "2026-02-01", loads: 7 }, { date: "2026-02-02", loads: 3 }],
    });
    expect(find).toHaveBeenCalledWith({
      _id: { $gte: "2026-01-04", $lte: "2026-02-02" }, expires_at: { $gt: now },
    });
    expect(limit).toHaveBeenCalledWith(30);
  });
});
