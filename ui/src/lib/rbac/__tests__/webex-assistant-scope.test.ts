/** @jest-environment node */
import { resolveWebexAssistantTeam } from "../webex-assistant-scope";
const mockFind = jest.fn();
jest.mock("../mongo-collections", () => ({ getRbacCollection: async () => ({ findOne: mockFind }) }));
jest.mock("../webex-space-grant-store", () => ({ webexWorkspaceRef: () => "example-workspace" }));
it("queries the active mapping for this bot, workspace and room", async () => {
  mockFind.mockResolvedValue({ team_slug: "example-team" });
  await expect(resolveWebexAssistantTeam("primary", "example-space")).resolves.toEqual({ workspaceId: "example-workspace", teamSlug: "example-team" });
  expect(mockFind).toHaveBeenCalledWith({ bot_id: "primary", webex_workspace_id: "example-workspace", webex_space_id: "example-space", active: { $ne: false } });
});
it.each([null, { team_slug: "team:invalid#member" }])("fails closed for missing or invalid mappings", async mapping => {
  mockFind.mockResolvedValue(mapping);
  await expect(resolveWebexAssistantTeam("secondary", "example-space")).rejects.toThrow();
});
