/** @jest-environment node */
import type { AuthResult } from "@/lib/da-proxy";
import { stageHarnessAttachments } from "../harness-attachments";

const mockUpdateOne = jest.fn().mockResolvedValue({});
jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn(async () => ({ updateOne: mockUpdateOne })) }));

it("normalizes MIME whitespace before storage and admission fingerprinting", async () => {
  const auth = { subject: "test-user" } as AuthResult;
  const first = await stageHarnessAttachments([{ data: "ZXhhbXBsZQ==", mime_type: " image/png " }], auth, "example", "thread");
  const retry = await stageHarnessAttachments([{ data: "ZXhhbXBsZQ==", mime_type: "image/png" }], auth, "example", "thread");
  expect(first).toEqual(retry);
  expect(mockUpdateOne.mock.calls[0][1].$setOnInsert.file.mime_type).toBe("image/png");
});
