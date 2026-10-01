/** @jest-environment node */
import { ApiError } from "@/lib/api-error";
import { OpenFgaMutationError, writeOpenFgaTupleDiff, type OpenFgaTupleKey } from "../openfga";

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

it("removes additions but never restores revoked access on an uncertain save", async () => {
  await expect(writeOpenFgaTupleDiff(diff, async () => { throw new Error("Mongo save failed"); }))
    .rejects.toThrow(OpenFgaMutationError);
  expect([...graph.values()]).toEqual([tuple("existing")]);
});

it.each(["AGENT_SAVE_CONFLICT", "PLATFORM_CONFIG_SAVE_CONFLICT"])(
  "keeps repair-required semantics after cleanup of %s", async code => {
    const conflict = new ApiError("Saved snapshot changed", 409, code);
    await expect(writeOpenFgaTupleDiff(diff, async () => { throw conflict; }))
      .rejects.toMatchObject({
        statusCode: 503, code: "ACCESS_UPDATE_INCOMPLETE", action: "contact_admin",
        cause: conflict, message: expect.stringContaining("Reference:"),
      });
    // Cleanup succeeded, but the old grant is still revoked: this is not a rollback.
    expect([...graph.values()]).toEqual([tuple("existing")]);
  },
);

it.each(["AGENT_SAVE_CONFLICT", "PLATFORM_CONFIG_SAVE_CONFLICT"])(
  "preserves the direct-persistence conflict %s without OpenFGA", async code => {
    delete process.env.OPENFGA_HTTP;
    const conflict = new ApiError("Saved snapshot changed", 409, code);
    await expect(writeOpenFgaTupleDiff(diff, async () => { throw conflict; })).rejects.toBe(conflict);
    expect(global.fetch).not.toHaveBeenCalled();
  },
);

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
  await expect(writeOpenFgaTupleDiff(diff, persist)).rejects.toThrow("Could not complete the save");
  expect(persist).not.toHaveBeenCalled();
});

it("returns a safe reference and logs causes when restrictive cleanup fails", async () => {
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(writeOpenFgaTupleDiff(diff, async () => {
      rejectWrites = true;
      throw new Error("Mongo save failed");
    })).rejects.toMatchObject({ statusCode: 503, code: "ACCESS_UPDATE_INCOMPLETE", message: expect.stringContaining("Reference:") });
    expect(log).toHaveBeenCalledWith("[openfga] mutation incomplete", expect.objectContaining({ cause: expect.any(AggregateError) }));
  } finally { log.mockRestore(); }
});

it("does not republish an agent when Mongo commits a demotion but loses the response", async () => {
  let visibility = "global";
  await expect(writeOpenFgaTupleDiff({ writes: [], deletes: [tuple("removed")] }, async () => {
    visibility = "team";
    throw new Error("response lost after commit");
  })).rejects.toThrow(OpenFgaMutationError);
  expect(visibility).toBe("team");
  expect(graph.has(key(tuple("removed")))).toBe(false);
});

it("does not undo a winning revocation when an overlapping save loses its snapshot", async () => {
  let enterSave!: () => void;
  const reachedSave = new Promise<void>(resolve => { enterSave = resolve; });
  let finishLosingSave!: () => void;
  const winningSaveCompleted = new Promise<void>(resolve => { finishLosingSave = resolve; });
  let version = "first";
  const losing = writeOpenFgaTupleDiff({ writes: [], deletes: [tuple("removed")] }, async () => {
    enterSave();
    await winningSaveCompleted;
    if (version !== "first") throw new Error("snapshot conflict");
  });
  const rejected = expect(losing).rejects.toThrow(OpenFgaMutationError);
  await reachedSave;
  await writeOpenFgaTupleDiff({ writes: [], deletes: [tuple("removed")] }, async () => { version = "second"; });
  finishLosingSave();
  await rejected;
  expect(graph.has(key(tuple("removed")))).toBe(false);
  expect(version).toBe("second");
});

it("cleans an addition whose OpenFGA response was lost after commit", async () => {
  const transport = global.fetch;
  let loseResponse = true;
  global.fetch = jest.fn(async (url, init) => {
    const response = await transport(url, init);
    if (loseResponse && String(url).endsWith("/write")) {
      loseResponse = false;
      throw new Error("response lost");
    }
    return response;
  });
  const persist = jest.fn(async () => {});
  await expect(writeOpenFgaTupleDiff({ writes: [tuple("new")], deletes: [] }, persist)).rejects.toThrow(OpenFgaMutationError);
  expect(graph.has(key(tuple("new")))).toBe(false);
  expect(persist).not.toHaveBeenCalled();
});

it.each([undefined, "false", "true"])("persists once without OpenFGA (flag %s)", async flag => {
  delete process.env.OPENFGA_HTTP;
  if (flag === undefined) delete process.env.OPENFGA_RECONCILE_ENABLED;
  else process.env.OPENFGA_RECONCILE_ENABLED = flag;
  const persist = jest.fn(async () => {});
  await expect(writeOpenFgaTupleDiff(diff, persist)).resolves.toMatchObject({ enabled: false });
  expect(persist).toHaveBeenCalledTimes(1);
  expect(global.fetch).not.toHaveBeenCalled();
});

it("does not persist when OpenFGA is configured but its writer is disabled", async () => {
  process.env.OPENFGA_RECONCILE_ENABLED = "false";
  const persist = jest.fn(async () => {});
  await expect(writeOpenFgaTupleDiff(diff, persist)).resolves.toMatchObject({ enabled: false });
  expect(persist).not.toHaveBeenCalled();
});

it("does not expose database details even if the permission diff is empty", async () => {
  await expect(writeOpenFgaTupleDiff({ writes: [], deletes: [] }, async () => { throw new Error("private database detail"); }))
    .rejects.toMatchObject({ code: "ACCESS_UPDATE_INCOMPLETE", message: expect.not.stringContaining("private database detail") });
});
