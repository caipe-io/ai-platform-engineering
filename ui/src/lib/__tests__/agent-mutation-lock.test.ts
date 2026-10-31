/** @jest-environment node */
import { withAgentMutationLock } from "../agent-mutation-lock";

const held = new Set<string>();
const remove = jest.fn(async (filter: { _id: string }) => held.delete(filter._id));
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({
  insertOne: async (value: { _id: string }) => { if (held.has(value._id)) throw Object.assign(new Error("busy"), { code: 11000 }); held.add(value._id); },
  deleteOne: (...args: unknown[]) => remove(...args as [{ _id: string }]),
}) }));

it("rejects a competing publisher before its side effects and releases after failure", async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const first = withAgentMutationLock("example", async () => { await waiting; throw new Error("save failed"); });
  const rejected = expect(first).rejects.toThrow("save failed");
  await Promise.resolve();
  const effects = jest.fn();
  await expect(withAgentMutationLock("example", effects)).rejects.toThrow("save is in progress");
  expect(effects).not.toHaveBeenCalled();
  release();
  await rejected;
  await withAgentMutationLock("example", effects);
  expect(effects).toHaveBeenCalledTimes(1);
  expect(held.size).toBe(0);
});
