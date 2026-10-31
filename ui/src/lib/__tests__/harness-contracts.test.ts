/** @jest-environment node */
import { harnessBuilderSections, supportsHarnessCapability, validateHarnessOptionsSchema } from "../harness-builder";
import { stageHarnessAttachments } from "../harness-attachments";
import type { HarnessDescriptor } from "@/types/harness-engine";

const updateOne = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ createIndex: jest.fn(), updateOne: (...args: unknown[]) => updateOne(...args) }) }));

const descriptor = { ui_schema: { version: 1, sections: [{ id: "middleware", title: "Middleware", step: "advanced", requires: ["deep_agents.middleware"], renderer: "deep-agents-middleware", valuePath: "/harness/options/runtime/features" }] }, capabilities: { "deep_agents.middleware": { level: "native" } } } as unknown as HarnessDescriptor;

it("uses host-owned panel IDs and effective capabilities", () => {
  expect(harnessBuilderSections(descriptor)).toHaveLength(1);
  expect(supportsHarnessCapability(descriptor, "deep_agents.middleware")).toBe(true);
  expect(supportsHarnessCapability(descriptor, "sandbox.isolation")).toBe(false);
  expect(() => harnessBuilderSections({ ...descriptor, ui_schema: { version: 2 } })).toThrow("version");
  expect(() => harnessBuilderSections({ ...descriptor, ui_schema: { version: 1, sections: [{ ...(descriptor.ui_schema.sections as object[])[0], renderer: "remote-javascript" }] } })).toThrow("unsupported editor");
});

it("stages stable, owner/conversation-scoped attachment references", async () => {
  const files = [{ data: Buffer.from("example").toString("base64"), mime_type: "text/plain", name: "example.txt" }];
  const one = await stageHarnessAttachments(files, { subject: "test-user" }, "example-agent", "example-thread");
  expect(await stageHarnessAttachments(files, { subject: "test-user" }, "example-agent", "example-thread")).toEqual(one);
  expect(await stageHarnessAttachments(files, { subject: "other-user" }, "example-agent", "example-thread")).not.toEqual(one);
  expect(await stageHarnessAttachments(files, { subject: "test-user" }, "example-agent", "other-thread")).not.toEqual(one);
  expect(updateOne).toHaveBeenCalledWith({ _id: one[0].id }, expect.objectContaining({ $setOnInsert: expect.objectContaining({ owner_subject: "test-user", conversation_id: "example-thread" }) }), { upsert: true });
  await expect(stageHarnessAttachments([{ data: "invalid!", mime_type: "text/plain" }], { subject: "test-user" }, "example-agent", "example-thread")).rejects.toThrow("base64");
  await expect(stageHarnessAttachments(files, {}, "example-agent", "example-thread")).rejects.toThrow("Invalid attachments");
});

it("rejects schema features that the bounded host form cannot render", () => {
  expect(() => validateHarnessOptionsSchema({ type: "object", properties: { examples: { type: "array", items: { type: "string" } } } })).not.toThrow();
  expect(() => validateHarnessOptionsSchema({ type: "object", properties: { value: { $ref: "https://example.test/schema" } } })).toThrow("Unsupported");
});

it("keeps legacy capability panels visible without a versioned UI schema", () => {
  expect(harnessBuilderSections({ ...descriptor, ui_schema: {} }).map(section => section.renderer)).toEqual(["deep-agents-middleware"]);
});
