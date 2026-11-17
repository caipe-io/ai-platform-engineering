/** @jest-environment node */
import { randomUUID } from "node:crypto";
import { MongoClient, type Db } from "mongodb";

let mockDb: Db;
jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: async (name: string) => mockDb.collection(name),
}));

import { readAppUsage, recordAppVisit } from "../app-usage";

// Run only against a throwaway local Mongo fixture; never an environment DB.
const uri = process.env.APP_USAGE_TEST_MONGODB_URI;
const integration = uri ? describe : describe.skip;
integration("aggregate usage with MongoDB", () => {
  let client: MongoClient;
  const originalEnabled = process.env.APP_USAGE_ENABLED;
  beforeAll(async () => {
    if (!uri || !["localhost", "127.0.0.1"].includes(new URL(uri).hostname)) {
      throw new Error("Usage integration fixture must be loopback-only");
    }
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    mockDb = client.db(`caipe_usage_test_${randomUUID().replaceAll("-", "")}`);
    process.env.APP_USAGE_ENABLED = "true";
  });
  afterAll(async () => {
    if (originalEnabled === undefined) delete process.env.APP_USAGE_ENABLED;
    else process.env.APP_USAGE_ENABLED = originalEnabled;
    await client?.close();
  });

  it("increments atomically and installs/exercises TTL expiry", async () => {
    const collection = mockDb.collection<{ _id: string; loads: number; expires_at: Date }>("app_usage_daily");
    await Promise.all(Array.from({ length: 25 }, () => recordAppVisit()));
    const rows = await collection.find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].loads).toBe(25);
    expect(Object.keys(rows[0]).sort()).toEqual(["_id", "expires_at", "loads"]);
    const index = (await collection.indexes()).find((item) => item.name === "app_usage_daily_expiry");
    expect(index?.expireAfterSeconds).toBe(0);

    const oldDay = new Date(Date.now() - 31 * 86_400_000);
    await recordAppVisit(oldDay);
    expect((await readAppUsage()).total_loads).toBe(25);
    // Fixture uses --setParameter ttlMonitorSleepSecs=1. Poll the database,
    // not just query filtering, to demonstrate physical deletion as well.
    const deadline = Date.now() + 10_000;
    while (await collection.countDocuments({ _id: oldDay.toISOString().slice(0, 10) }) !== 0) {
      if (Date.now() >= deadline) throw new Error("Expired fixture counter was not removed by TTL monitor");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 15_000);
});
