/** @jest-environment node */
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

import { requireAgentUsePermission } from "../openfga-agent-authz";
import { emitDecisionAudit } from "@/lib/authz/audit";

// Only audit delivery is mocked: guard → CAS → HTTP → real OpenFGA is exercised.
jest.mock("@/lib/authz/audit", () => ({ emitDecisionAudit: jest.fn() }));

const endpoint = process.env.OPENFGA_AGENT_USE_TEST_URL;
const suite = endpoint ? describe : describe.skip;
type Tuple = { user: string; relation: string; object: string };

suite("agent execution against the deployed chart model (isolated local OpenFGA)", () => {
  let base: string;
  let storeId: string | undefined;
  const previous = { url: process.env.OPENFGA_HTTP, store: process.env.OPENFGA_STORE_ID };
  const teamMember = { user: "user:test-member", relation: "member", object: "team:primary" };
  const direct = { user: "user:test-direct", relation: "user", object: "agent:private" };
  const check = (subject: string, agentId = "private", isServiceAccount = false, email?: string) =>
    requireAgentUsePermission({ subject, agentId, isServiceAccount, email });

  async function request(path: string, body?: unknown, method = "POST"): Promise<Record<string, string>> {
    const response = await fetch(base + path, {
      method, headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Local OpenFGA ${path}: ${response.status} ${await response.text()}`);
    return response.status === 204 ? {} : response.json();
  }
  const mutate = (operation: "writes" | "deletes", tuples: Tuple[]) =>
    request(`/stores/${storeId}/write`, { [operation]: { tuple_keys: tuples } });

  beforeAll(async () => {
    if (jest.isMockFunction(global.fetch)) throw new Error("Use jest.openfga.config.js for real HTTP tests");
    const url = new URL(endpoint!);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("This fixture may only run against an isolated loopback OpenFGA server");
    }
    base = url.origin;
    storeId = (await request("/stores", { name: `agent-use-test-${randomUUID()}` })).id;
    if (!storeId) throw new Error("Local OpenFGA did not return a disposable store ID");
    const model = JSON.parse(readFileSync(resolve(
      process.cwd(), "../charts/ai-platform-engineering/charts/openfga/authorization-model.json",
    ), "utf8"));
    await request(`/stores/${storeId}/authorization-models`, model);
    process.env.OPENFGA_HTTP = base;
    process.env.OPENFGA_STORE_ID = storeId;
    await mutate("writes", [
      direct, teamMember,
      { user: "user:test-team-admin", relation: "admin", object: "team:primary" },
      { user: "team:primary#member", relation: "user", object: "agent:private" },
      { user: "user:test-owner", relation: "owner", object: "agent:private" },
      { user: "user:test-reader", relation: "reader", object: "agent:private" },
      { user: "user:test-writer", relation: "writer", object: "agent:private" },
      { user: "user:test-manager", relation: "manager", object: "agent:private" },
      { user: "user:test-org-admin", relation: "admin", object: "organization:primary" },
      { user: "organization:primary#admin", relation: "manager", object: "agent:private" },
      { user: "user:*", relation: "user", object: "agent:public" },
      { user: "service_account:test-service", relation: "user", object: "agent:private" },
      { user: "user:legacy@example.com", relation: "owner", object: "agent:legacy" },
    ]);
  });

  afterAll(async () => {
    try {
      // Delete only the disposable store created by this suite.
      if (storeId) await request(`/stores/${storeId}`, undefined, "DELETE");
    } finally {
      if (previous.url === undefined) delete process.env.OPENFGA_HTTP;
      else process.env.OPENFGA_HTTP = previous.url;
      if (previous.store === undefined) delete process.env.OPENFGA_STORE_ID;
      else process.env.OPENFGA_STORE_ID = previous.store;
    }
  });

  it.each(["test-direct", "test-member", "test-team-admin", "test-owner", "test-writer", "test-manager", "test-org-admin"])(
    "allows %s through the model without an application team loop", async (subject) => {
      jest.mocked(emitDecisionAudit).mockClear();
      expect(await check(subject)).toBeNull();
      expect(emitDecisionAudit).toHaveBeenCalledTimes(1);
    },
  );
  it("denies a reader, unrelated user, and org admin without an agent relationship", async () => {
    expect((await check("test-reader"))?.status).toBe(403);
    expect((await check("test-unrelated"))?.status).toBe(403);
    expect((await check("test-org-admin", "ungranted"))?.status).toBe(403);
  });
  it("keeps human and service-account identities distinct", async () => {
    expect(await check("test-service", "private", true)).toBeNull();
    expect((await check("test-service"))?.status).toBe(403);
    expect((await check("test-member", "private", true))?.status).toBe(403);
    expect(await check("test-unrelated", "public")).toBeNull();
    expect((await check("test-service", "public", true))?.status).toBe(403);
  });
  it("does not use email ownership as an alternate identity", async () => {
    expect((await check("test-legacy", "legacy", false, "legacy@example.com"))?.status).toBe(403);
  });
  it("observes direct grant removal and re-addition on the next check", async () => {
    expect(await check("test-direct")).toBeNull();
    await mutate("deletes", [direct]);
    expect((await check("test-direct"))?.status).toBe(403);
    await mutate("writes", [direct]);
    expect(await check("test-direct")).toBeNull();
  });
  it("removing a team membership keeps another grant, then denies when the last grant is removed", async () => {
    const extra = { user: "user:test-member", relation: "user", object: "agent:private" };
    await mutate("writes", [extra]);
    await mutate("deletes", [teamMember]);
    expect(await check("test-member")).toBeNull();
    await mutate("deletes", [extra]);
    expect((await check("test-member"))?.status).toBe(403);
    await mutate("writes", [teamMember]);
    expect(await check("test-member")).toBeNull();
  });
});
