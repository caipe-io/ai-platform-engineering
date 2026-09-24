/** @jest-environment node */
import { checkOpenFgaTuple, getOpenFgaStoreId, readOpenFgaTuples } from "@/lib/rbac/openfga";
import { withAuthzSpan } from "@/lib/rbac/authz-tracing";
import { createOpenFgaAdmin, createOpenFgaEngine, __resetAdapterStateForTests } from "../engines/openfga";
import { requestOpenFga } from "../engines/openfga-client";

const request = {
  subject: { type: "user" as const, id: "test-user" },
  resource: { type: "agent" as const, id: "example" },
  action: "use" as const,
};
const tuple = { user: "user:test-user", relation: "can_use", object: "agent:example" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const stores = (id = "store-primary") => response({ stores: [{ id, name: "example" }] });
const originalFetch = global.fetch;
const originalEnv = { ...process.env };
let fetchMock: jest.Mock;

beforeEach(() => {
  process.env.OPENFGA_HTTP = " http://openfga.example.test:8080/// ";
  process.env.OPENFGA_STORE_NAME = "example";
  delete process.env.OPENFGA_STORE_ID;
  delete process.env.CAIPE_UNSAFE_RBAC_BYPASS;
  delete process.env.AUTHZ_TRACING_ENABLED;
  __resetAdapterStateForTests();
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const key of ["OPENFGA_HTTP", "OPENFGA_STORE_NAME", "OPENFGA_STORE_ID", "CAIPE_UNSAFE_RBAC_BYPASS", "AUTHZ_TRACING_ENABLED"]) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  __resetAdapterStateForTests();
});

it("shares in-flight discovery between CAS and RBAC checks", async () => {
  let finishDiscovery!: (value: Response) => void;
  const discovery = new Promise<Response>((resolve) => { finishDiscovery = resolve; });
  fetchMock.mockImplementation((url: string) => url.endsWith("/stores") ? discovery : response({ allowed: true }));
  const cas = createOpenFgaEngine().check(request);
  const rbac = checkOpenFgaTuple(tuple);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  finishDiscovery(stores());
  expect((await cas).decision).toBe("ALLOW");
  expect(await rbac).toEqual({ allowed: true });
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    "http://openfga.example.test:8080/stores",
    "http://openfga.example.test:8080/stores/store-primary/check",
    "http://openfga.example.test:8080/stores/store-primary/check",
  ]);
  for (const [, options] of fetchMock.mock.calls.slice(1)) {
    expect(JSON.parse(options.body)).toEqual({ tuple_key: tuple });
  }
});

it("uses an explicit store without discovery and forwards the CAS trace context", async () => {
  process.env.OPENFGA_STORE_ID = " store-explicit ";
  fetchMock.mockImplementation(() => response({ allowed: true }));
  await withAuthzSpan("test", {}, async (context) => {
    await createOpenFgaEngine().check(request);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://openfga.example.test:8080/stores/store-explicit/check",
      expect.objectContaining({ headers: { "Content-Type": "application/json", traceparent: context.traceparent } }),
    );
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each(["network", "http", "missing-store"])("retries discovery after a %s failure", async (failure) => {
  if (failure === "network") fetchMock.mockRejectedValueOnce(new Error("unavailable"));
  else fetchMock.mockResolvedValueOnce(failure === "http" ? response({}, 503) : response({ stores: [] }));
  fetchMock.mockResolvedValueOnce(stores());
  await expect(getOpenFgaStoreId()).rejects.toThrow();
  await expect(getOpenFgaStoreId()).resolves.toBe("store-primary");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("invalidates shared discovery after a missing store without replaying the failed operation", async () => {
  fetchMock.mockResolvedValueOnce(stores()).mockResolvedValueOnce(response({}, 404));
  await expect(readOpenFgaTuples()).rejects.toThrow("404");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  fetchMock.mockResolvedValueOnce(stores("store-secondary")).mockResolvedValueOnce(response({ allowed: true }));
  expect((await createOpenFgaEngine().check(request)).decision).toBe("ALLOW");
  expect(fetchMock.mock.calls[3][0]).toContain("/stores/store-secondary/check");
});

it("does not retry a failed grant or turn it into a success", async () => {
  process.env.OPENFGA_STORE_ID = "store-primary";
  fetchMock.mockResolvedValueOnce(response({}, 503));
  await expect(createOpenFgaAdmin().grant({
    resource: request.resource,
    capability: "use",
    grantee: { type: "user", id: "test-user" },
  })).rejects.toThrow("503");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("does not inherit the legacy unsafe bypass in the CAS engine", async () => {
  process.env.CAIPE_UNSAFE_RBAC_BYPASS = "true";
  process.env.OPENFGA_STORE_ID = "store-primary";
  fetchMock.mockResolvedValueOnce(response({ allowed: false }));
  expect(await createOpenFgaEngine().check(request)).toMatchObject({
    decision: "DENY", reason: "NO_CAPABILITY",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("rejects a missing endpoint without making a request", async () => {
  delete process.env.OPENFGA_HTTP;
  await expect(requestOpenFga("/stores", { method: "GET" })).rejects.toThrow("OPENFGA_HTTP is not set");
  expect(fetchMock).not.toHaveBeenCalled();
});
