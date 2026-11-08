/** @jest-environment node */
import { NextResponse } from "next/server";
import { reserveCoordinationTurn, recordCoordinationRun, rejectCoordinationTurn, coordinationAdmissionId } from "../chat-coordination-admission";
const mockFeatures = jest.fn();
jest.mock("@/lib/coordination/features.server", () => ({ getCoordinationFeatures: () => mockFeatures() }));
const mockFind = jest.fn();
const mockInsert = jest.fn();
const mockReplace = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async (name: string) => name === "conversations"
  ? { findOne: async () => ({ participants: [{ type: "agent", id: "primary" }], coordination_agents: [{ agent_id: "helper" }] }) }
  : { findOne: mockFind, insertOne: mockInsert, replaceOne: mockReplace, updateOne: mockUpdate, deleteOne: mockDelete } }));
const auth = { subject: "test-owner" };
const body = () => ({ agent_id: "helper", conversation_id: "chat-example", client_request_id: "new-request" });
const previous = { _id: coordinationAdmissionId("chat-example", "helper"), generation: "previous", agent_id: "helper", owner_subject: "test-owner", request_id: "previous-request", run_id: "previous-run" };
function scopedPrevious(value: unknown) {
  mockFind.mockImplementation(async (query: { _id: string }) => query._id === "chat-example" ? null : value);
}
beforeEach(() => {
  jest.resetAllMocks();
  mockFeatures.mockResolvedValue({ enabled: true, team: true });
  process.env.HARNESS_ENGINE_URL = "https://engine.example.test";
  process.env.HARNESS_ENGINE_INTERNAL_TOKEN = "test-internal-token";
  mockFind.mockImplementation(async () => null);
  mockReplace.mockResolvedValue({ modifiedCount: 1 });
});
afterEach(() => jest.restoreAllMocks());
it("uses Mongo's unique participant key to reject overlapping turns for the same agent", async () => {
  mockInsert.mockRejectedValue({ code: 11000 });
  expect((await reserveCoordinationTurn(body(), auth) as NextResponse).status).toBe(409);
});
it("keeps an unconfirmed admission fenced instead of clearing it on browser disconnect", async () => {
  scopedPrevious({ ...previous, run_id: undefined });
  expect((await reserveCoordinationTurn(body(), auth) as NextResponse).status).toBe(409);
  expect(mockReplace).not.toHaveBeenCalled();
});
it.each(["running", "paused", "completed"])("checks authoritative state of a previous %s turn before switching agents", async status => {
  scopedPrevious(previous);
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(Response.json({ data: { run_id: "previous-run", conversation_id: "chat-example", agent_id: "helper", status } }));
  const result = await reserveCoordinationTurn(body(), auth);
  if (status === "completed") expect(result).toMatchObject({ agent_id: "helper", request_id: "new-request" });
  else expect((result as NextResponse).status).toBe(409);
  expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ "X-Harness-Engine-Subject": "test-owner", "X-Harness-Read-Agent": "helper", "X-Harness-Read-Conversation": "chat-example" });
});
it("allows the same idempotent request to recover admission", async () => {
  scopedPrevious({ ...previous, agent_id: "helper", request_id: "new-request" });
  expect(await reserveCoordinationTurn(body(), auth)).toMatchObject({ generation: "previous" });
  expect(mockInsert).not.toHaveBeenCalled();
});
it("records the run before opening a browser subscription", async () => {
  const ticket = await reserveCoordinationTurn(body(), auth);
  await recordCoordinationRun(ticket as Exclude<typeof ticket, NextResponse>, { run_id: "new-run" } as import("@/types/harness-engine").HarnessRun);
  expect(mockUpdate).toHaveBeenCalledWith({ _id: coordinationAdmissionId("chat-example", "helper"), generation: expect.any(String) }, { $set: { run_id: "new-run" } });
});

it("restores the paused turn fence when its resume is rejected", async () => {
  scopedPrevious({ ...previous, agent_id: "helper" });
  jest.spyOn(global, "fetch").mockResolvedValue(Response.json({ data: { run_id: "previous-run", conversation_id: "chat-example", agent_id: "helper", status: "paused" } }));
  const ticket = await reserveCoordinationTurn({ ...body(), command: "resume" }, auth);
  await rejectCoordinationTurn(ticket as Exclude<typeof ticket, NextResponse>);
  expect(mockReplace).toHaveBeenLastCalledWith(expect.objectContaining({ generation: expect.any(String), run_id: { $exists: false } }), { ...previous, agent_id: "helper" });
});

it("blocks new participant turns when disabled while preserving primary turns and paused-run recovery", async () => {
  mockFeatures.mockResolvedValue({ enabled: false, team: false });
  expect((await reserveCoordinationTurn(body(), auth) as NextResponse).status).toBe(403);
  expect(mockInsert).not.toHaveBeenCalled();
  expect(await reserveCoordinationTurn({ ...body(), agent_id: "primary" }, auth)).toMatchObject({ agent_id: "primary" });
  scopedPrevious({ ...previous, agent_id: "helper" });
  jest.spyOn(global, "fetch").mockResolvedValue(Response.json({ data: { run_id: "previous-run", conversation_id: "chat-example", agent_id: "helper", status: "paused" } }));
  expect(await reserveCoordinationTurn({ ...body(), command: "resume" }, auth)).toMatchObject({ agent_id: "helper" });
});

it("admits independent participants concurrently under distinct keys", async () => {
  await Promise.all([reserveCoordinationTurn(body(), auth), reserveCoordinationTurn({ ...body(), agent_id: "primary" }, auth)]);
  expect(mockInsert).toHaveBeenCalledTimes(2);
  expect(new Set(mockInsert.mock.calls.map(call => call[0]._id)).size).toBe(2);
});
it.each(["running", "paused"])("keeps a legacy %s producer fenced during migration", async status => {
  mockFind.mockImplementation(async (query: { _id: string }) => query._id === "chat-example" ? { ...previous, _id: "chat-example", agent_id: "primary" } : null);
  jest.spyOn(global, "fetch").mockResolvedValue(Response.json({ data: { run_id: "previous-run", conversation_id: "chat-example", agent_id: "primary", status } }));
  expect((await reserveCoordinationTurn(body(), auth) as NextResponse).status).toBe(409);
  expect(mockInsert).not.toHaveBeenCalled();
  expect(mockDelete).not.toHaveBeenCalled();
});
it("migrates a terminal legacy fence before admitting participant runs", async () => {
  let legacy: unknown = { ...previous, _id: "chat-example", agent_id: "primary" };
  mockFind.mockImplementation(async (query: { _id: string }) => query._id === "chat-example" ? legacy : null);
  mockDelete.mockImplementation(async () => { legacy = null; });
  jest.spyOn(global, "fetch").mockResolvedValue(Response.json({ data: { run_id: "previous-run", conversation_id: "chat-example", agent_id: "primary", status: "completed" } }));
  expect(await reserveCoordinationTurn(body(), auth)).toMatchObject({ _id: coordinationAdmissionId("chat-example", "helper") });
  expect(mockDelete).toHaveBeenCalledWith({ _id: "chat-example", generation: "previous" });
});
