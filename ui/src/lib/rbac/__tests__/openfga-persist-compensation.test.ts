/** @jest-environment node */
import { writeOpenFgaTupleDiff, type OpenFgaTupleKey } from "../openfga";

const originalFetch = global.fetch;
const originalEnv = { ...process.env };
const tuple = (id: string): OpenFgaTupleKey => ({ user: "user:*", relation: "user", object: `agent:${id}` });
const key = (value: OpenFgaTupleKey) => `${value.user}|${value.relation}|${value.object}`;
let graph: Map<string, OpenFgaTupleKey>;
let rejectWrites: boolean;

beforeEach(() => {
  process.env.OPENFGA_HTTP = "http://openfga.example.test";
  process.env.OPENFGA_STORE_ID = "example-store";
  process.env.OPENFGA_RECONCILE_ENABLED = "true";
  process.env.OPENFGA_MAX_WRITES_PER_BATCH = "1";
  graph = new Map([tuple("existing"), tuple("removed")].map(t => [key(t), t]));
  rejectWrites = false;
  global.fetch = jest.fn(async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (String(url).endsWith("/read")) {
      const found = graph.get(key(body.tuple_key));
      return Response.json({ tuples: found ? [{ key: found }] : [] });
    }
    if (String(url).endsWith("/write")) {
      if (rejectWrites) return new Response("write failed", { status: 503 });
      for (const t of body.writes?.tuple_keys ?? []) graph.set(key(t), t);
      for (const t of body.deletes?.tuple_keys ?? []) graph.delete(key(t));
      return Response.json({});
    }
    throw new Error("Unexpected OpenFGA operation");
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const name of ["OPENFGA_HTTP", "OPENFGA_STORE_ID", "OPENFGA_RECONCILE_ENABLED", "OPENFGA_MAX_WRITES_PER_BATCH"]) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
});

const diff = { writes: [tuple("existing"), tuple("new")], deletes: [tuple("removed")] };

it("saves only after every grant chunk has been applied", async () => {
  const persist = jest.fn(async () => {
    expect([...graph.values()]).toEqual([tuple("existing"), tuple("new")]);
  });
  await expect(writeOpenFgaTupleDiff(diff, persist)).resolves.toEqual({ enabled: true, writes: 1, deletes: 1 });
  expect(persist).toHaveBeenCalledTimes(1);
});

it("undoes only changed grants when saving fails; pre-existing grants survive", async () => {
  await expect(writeOpenFgaTupleDiff(diff, async () => { throw new Error("Mongo save failed"); }))
    .rejects.toThrow("Mongo save failed");
  expect([...graph.values()]).toEqual([tuple("existing"), tuple("removed")]);
});

it.each([{ writes: [], deletes: [] }, { writes: [tuple("existing")], deletes: [] }])(
  "still saves when the tuple diff is a no-op: %j", async noOp => {
    const persist = jest.fn(async () => {});
    await writeOpenFgaTupleDiff(noOp, persist);
    expect(persist).toHaveBeenCalledTimes(1);
    expect([...graph.values()]).toEqual([tuple("existing"), tuple("removed")]);
  },
);

it("does not save config when a grant write fails", async () => {
  rejectWrites = true;
  const persist = jest.fn(async () => {});
  await expect(writeOpenFgaTupleDiff(diff, persist)).rejects.toThrow("OpenFGA tuple write failed");
  expect(persist).not.toHaveBeenCalled();
});

it("surfaces the original save failure and logs failed compensation", async () => {
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(writeOpenFgaTupleDiff(diff, async () => {
      rejectWrites = true;
      throw new Error("Mongo save failed");
    })).rejects.toThrow("Mongo save failed");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("manual cleanup may be required"), expect.anything());
  } finally { log.mockRestore(); }
});
