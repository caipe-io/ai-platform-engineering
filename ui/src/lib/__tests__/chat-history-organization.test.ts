import { EMPTY_CHAT_ORGANIZATION, parseChatHistoryOrganization } from "../chat-history-organization";

const folder = { id: "example-folder", name: "Example" };
it("preserves personal organization independently of conversation content", () => {
  expect(parseChatHistoryOrganization({ view: "folders", folders: [folder], assignments: { "example-chat": folder.id }, collapsed: ["folder:example-folder"] }))
    .toEqual({ view: "folders", folders: [folder], assignments: { "example-chat": folder.id }, collapsed: ["folder:example-folder"] });
});
it.each([
  { ...EMPTY_CHAT_ORGANIZATION, folders: [folder, { ...folder, id: "other", name: " example " }] },
  { ...EMPTY_CHAT_ORGANIZATION, assignments: { "example-chat": "missing" } },
  { ...EMPTY_CHAT_ORGANIZATION, folders: [{ ...folder, name: "x".repeat(81) }] },
  { ...EMPTY_CHAT_ORGANIZATION, folders: [folder], assignments: { "$bad": folder.id } },
])("rejects invalid names and assignments", value => {
  expect(() => parseChatHistoryOrganization(value)).toThrow();
});
