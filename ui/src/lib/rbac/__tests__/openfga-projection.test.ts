/** @jest-environment node */
import { applyOpenFgaProjection, type OpenFgaTupleKey } from "../openfga";

const beforeEnv = { ...process.env };
const beforeFetch = global.fetch;
const old = { user: "user:previous", relation: "owner", object: "agent:example" };
const next = { ...old, user: "user:next" };
const key = (tuple: OpenFgaTupleKey) => JSON.stringify(tuple);
let graph: Map<string, OpenFgaTupleKey>;
let loseResponse: boolean;

beforeEach(() => {
  process.env.OPENFGA_HTTP = "https://openfga.example.test";
  process.env.OPENFGA_STORE_ID = "example-store";
  process.env.OPENFGA_RECONCILE_ENABLED = "true";
  graph = new Map([[key(old), old]]);
  loseResponse = false;
  global.fetch = jest.fn(async (url, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith("/read")) {
      const tuple = graph.get(key(body.tuple_key));
      return Response.json({ tuples: tuple ? [{ key: tuple }] : [] });
    }
    if (String(url).endsWith("/write")) {
      for (const tuple of body.deletes?.tuple_keys ?? []) graph.delete(key(tuple));
      for (const tuple of body.writes?.tuple_keys ?? []) graph.set(key(tuple), tuple);
      if (loseResponse) { loseResponse = false; throw new Error("Connection lost after commit"); }
      return Response.json({});
    }
    throw new Error(`Unexpected operation: ${url}`);
  });
});
afterEach(() => {
  global.fetch = beforeFetch;
  for (const name of ["OPENFGA_HTTP", "OPENFGA_STORE_ID", "OPENFGA_RECONCILE_ENABLED"]) {
    if (beforeEnv[name] === undefined) delete process.env[name];
    else process.env[name] = beforeEnv[name];
  }
});

it("removes old access before adding new access, with a lease check for each batch", async () => {
  const lease = jest.fn().mockResolvedValue(undefined);
  await applyOpenFgaProjection({ writes: [next], deletes: [old] }, lease);
  const writes = jest.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/write"));
  expect(writes.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { deletes: { tuple_keys: [old] } }, { writes: { tuple_keys: [next] } },
  ]);
  expect(lease).toHaveBeenCalledTimes(2);
  expect([...graph.values()]).toEqual([next]);
});

it("retries an ambiguous result idempotently, without restoring revoked access", async () => {
  loseResponse = true;
  const diff = { writes: [next], deletes: [old] };
  await expect(applyOpenFgaProjection(diff, async () => {})).rejects.toThrow("Connection lost");
  expect(graph.has(key(old))).toBe(false);
  await applyOpenFgaProjection(diff, async () => {});
  expect([...graph.values()]).toEqual([next]);
  expect(jest.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/write"))).toHaveLength(2);
});

it("does not send a mutation after losing its lease", async () => {
  await expect(applyOpenFgaProjection({ writes: [next], deletes: [old] }, async () => { throw new Error("Lease lost"); })).rejects.toThrow("Lease lost");
  expect(jest.mocked(fetch).mock.calls.every(([url]) => String(url).endsWith("/read"))).toBe(true);
});
