/** @jest-environment node */
const mockFindOne = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ findOne: mockFindOne }) }));
jest.mock("@/lib/feature-flags/private-resources", () => ({ isPrivateResourcesEnabled: () => true }));
import { ingestorMayUseSecret } from "../ingest-credential-usage.server";

it.each([
  { visibility: "private" },
  { owner: { type: "user" }, sharedWithTeams: [] },
])("keeps private credentials outside unattended ingestion fallback: %j", async (secret) => {
  mockFindOne.mockReset().mockResolvedValueOnce(secret).mockResolvedValue({ _id: "saved-source" });
  expect(await ingestorMayUseSecret("example")).toBe(false);
  expect(mockFindOne).toHaveBeenCalledTimes(1);
});

it("retains shared credential access for saved ingestion work", async () => {
  mockFindOne.mockReset().mockResolvedValueOnce({ visibility: "team" }).mockResolvedValueOnce({ _id: "saved-source" });
  expect(await ingestorMayUseSecret("example")).toBe(true);
});
