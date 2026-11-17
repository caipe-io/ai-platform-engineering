/** @jest-environment node */
import { conversationPresenceStream } from "../conversation-presence";

const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockDeleteExpired = jest.fn();
const mockAggregate = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({
  updateOne: mockUpdate, deleteOne: mockDelete, deleteMany: mockDeleteExpired, aggregate: mockAggregate,
}) }));
jest.mock("timers/promises", () => ({ setTimeout: (ms: number, value: unknown, { signal }: { signal: AbortSignal }) =>
  new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(Object.assign(new Error("Aborted"), { name: "AbortError" })); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(value); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }),
}));

const auth = { subject: "primary", email: "primary@example.test" };
let leases: Map<string, Record<string, unknown>>;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  jest.clearAllMocks();
  leases = new Map();
  mockUpdate.mockImplementation(async ({ _id }, { $set }) => { leases.set(_id, $set); });
  mockDelete.mockImplementation(async ({ _id }) => { leases.delete(_id); });
  mockDeleteExpired.mockImplementation(async ({ expires_at }) => {
    for (const [id, lease] of leases) {
      if ((lease.expires_at as Date) <= expires_at.$lte) leases.delete(id);
    }
  });
  mockAggregate.mockImplementation(([{ $match }]) => ({ toArray: async () => {
    const groups = new Map<string, { _id: string; name: unknown; sessions: number }>();
    for (const lease of leases.values()) {
      if (lease.conversation_id !== $match.conversation_id || (lease.expires_at as Date) <= $match.expires_at.$gt) continue;
      const id = lease.viewer_id as string;
      const viewer = groups.get(id) ?? { _id: id, name: lease.name, sessions: 0 };
      viewer.sessions++;
      groups.set(id, viewer);
    }
    return Array.from(groups.values());
  } }));
});
afterEach(() => { jest.useRealTimers(); });

async function snapshot(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  return JSON.parse(text.split("data: ")[1]);
}

it("groups two browser connections for one user and keeps another user separate", async () => {
  const readers = [auth, auth, { subject: "secondary", email: "secondary@example.test" }]
    .map(user => conversationPresenceStream("chat-example", user, new AbortController().signal, async () => true).getReader());
  await Promise.all(readers.map(snapshot));
  await jest.advanceTimersByTimeAsync(5_000);
  const presence = await snapshot(readers[0]);
  expect(presence.sessionCount).toBe(3);
  expect(presence.viewers).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "primary@example.test", sessions: 2 }),
    expect.objectContaining({ name: "secondary@example.test", sessions: 1 }),
  ]));
  expect(presence.viewers).toHaveLength(2);
  await Promise.all(readers.map(reader => reader.cancel()));
  expect(leases.size).toBe(0);
});

it("excludes expired and other-conversation leases before Mongo TTL cleanup", async () => {
  leases.set("expired", { conversation_id: "chat-example", viewer_id: "expired", expires_at: new Date(Date.now()), name: "Expired" });
  leases.set("other", { conversation_id: "other-chat", viewer_id: "other", expires_at: new Date(Date.now() + 30_000), name: "Other" });
  const reader = conversationPresenceStream("chat-example", auth, new AbortController().signal, async () => true).getReader();
  expect((await snapshot(reader)).sessionCount).toBe(1);
  expect(mockAggregate.mock.calls[0][0][0].$match).toEqual({ conversation_id: "chat-example", expires_at: { $gt: expect.any(Date) } });
  await reader.cancel();
});

it("removes disconnected viewers and closes without touching agent runs", async () => {
  const abort = new AbortController();
  const reader = conversationPresenceStream("chat-example", auth, abort.signal, async () => true).getReader();
  await snapshot(reader);
  abort.abort();
  expect((await reader.read()).done).toBe(true);
  expect(leases.size).toBe(0);
});

it("stops publishing and releases its lease when read permission is revoked", async () => {
  const canRead = jest.fn().mockResolvedValue(false);
  const reader = conversationPresenceStream("chat-example", auth, new AbortController().signal, canRead).getReader();
  await snapshot(reader);
  for (let i = 0; i < 2; i++) {
    await jest.advanceTimersByTimeAsync(5_000);
    await snapshot(reader);
  }
  await jest.advanceTimersByTimeAsync(5_000);
  const event = new TextDecoder().decode((await reader.read()).value);
  expect(event).toContain("event: access-revoked");
  expect((await reader.read()).done).toBe(true);
  expect(canRead).toHaveBeenCalledTimes(1);
  expect(leases.size).toBe(0);
});

it("does not register an already disconnected request", async () => {
  const abort = new AbortController();
  abort.abort();
  const reader = conversationPresenceStream("chat-example", auth, abort.signal, async () => true).getReader();
  expect((await reader.read()).done).toBe(true);
  expect(mockUpdate).not.toHaveBeenCalled();
});

it("renews a connected viewer while a roster query exceeds the lease lifetime", async () => {
  let finishQuery!: (groups: unknown[]) => void;
  mockAggregate.mockImplementationOnce(() => ({ toArray: () => new Promise(resolve => { finishQuery = resolve; }) }));
  const reader = conversationPresenceStream("chat-example", auth, new AbortController().signal, async () => true).getReader();
  await jest.advanceTimersByTimeAsync(35_000);
  expect(mockUpdate).toHaveBeenCalledTimes(8);
  expect([...leases.values()][0].expires_at).toEqual(new Date(Date.now() + 30_000));
  finishQuery([]);
  await snapshot(reader);
  await reader.cancel();
  await jest.advanceTimersByTimeAsync(0);
  expect(leases.size).toBe(0);
});

it("rechecks access after a slow roster query before sending viewer names", async () => {
  let finishQuery!: (groups: unknown[]) => void;
  mockAggregate.mockImplementationOnce(() => ({ toArray: () => new Promise(resolve => { finishQuery = resolve; }) }));
  const canRead = jest.fn().mockResolvedValue(false);
  const reader = conversationPresenceStream("chat-example", auth, new AbortController().signal, canRead).getReader();
  await jest.advanceTimersByTimeAsync(20_000);
  finishQuery([{ _id: "secondary", name: "Secondary User", sessions: 1 }]);
  const event = new TextDecoder().decode((await reader.read()).value);
  expect(event).toContain("event: access-revoked");
  expect(event).not.toContain("Secondary User");
  expect((await reader.read()).done).toBe(true);
  expect(canRead).toHaveBeenCalledTimes(1);
  expect(leases.size).toBe(0);
});

it("periodically reclaims crashed connections even without a TTL index", async () => {
  const reader = conversationPresenceStream("chat-example", auth, new AbortController().signal, async () => true).getReader();
  await snapshot(reader);
  leases.set("crashed", { conversation_id: "closed-chat", expires_at: new Date(Date.now() + 30_000) });
  await jest.advanceTimersByTimeAsync(60_000);
  expect(mockDeleteExpired).toHaveBeenCalledTimes(2);
  expect(leases.has("crashed")).toBe(false);
  expect(leases.size).toBe(1);
  await reader.cancel();
  await jest.advanceTimersByTimeAsync(0);
  expect(leases.size).toBe(0);
});
