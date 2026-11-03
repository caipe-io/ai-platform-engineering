/** @jest-environment node */
import { registerOperatorNotificationType } from "../operator-registration.server";
const mockUpdate = jest.fn();
const mockProducer = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async () => ({ updateOne: (...args: unknown[]) => mockUpdate(...args) }) }));
jest.mock("@/lib/agentic-apps/config", () => ({ getConfiguredAgenticApp: () => ({ manifest: { displayName: "Example" }, installation: { bindings: { serviceAccountClientId: "publisher" } } }) }));
jest.mock("@/lib/agentic-apps/notification-producer", () => ({ findNotificationProducer: () => mockProducer() }));
jest.mock("../subscriptions.server", () => ({ validateNotificationTypes: (events: unknown[]) => events }));
beforeEach(() => { jest.clearAllMocks(); mockProducer.mockReturnValue({}); mockUpdate.mockResolvedValue({ matchedCount: 1 }); });
it("stores operator events independently of the app-owned list", async () => {
  await registerOperatorNotificationType({ sourceId: "app:example", event: { id: "report.ready", label: "Report" } });
  expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ "events.id": { $ne: "report.ready" } }), expect.objectContaining({ $push: { operatorEvents: { id: "report.ready", label: "Report" } } }));
});
it("refuses platform event fabrication and apps without publisher capability", async () => {
  await expect(registerOperatorNotificationType({ sourceId: "platform", event: {} })).rejects.toMatchObject({ statusCode: 400 });
  mockProducer.mockReturnValue(null);
  await expect(registerOperatorNotificationType({ sourceId: "app:example", event: {} })).rejects.toMatchObject({ statusCode: 403 });
});
it("reports concurrent duplicates without replacing declarations", async () => {
  mockUpdate.mockResolvedValueOnce({}).mockRejectedValueOnce({ code: 11000 });
  await expect(registerOperatorNotificationType({ sourceId: "app:example", event: { id: "report.ready" } })).rejects.toMatchObject({ statusCode: 409 });
});
