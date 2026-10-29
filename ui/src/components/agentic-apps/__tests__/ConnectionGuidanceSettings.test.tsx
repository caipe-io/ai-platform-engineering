import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConnectionGuidanceSettings } from "../ConnectionGuidanceSettings";

jest.mock("../AssistantConnectionGuidance", () => ({ ConnectionGuideButtons: () => null }));

const guide = { id: "webex", enabled: true, label: "Connect via Webex", title: "Instructions", markdown: "Start a conversation with example-bot@example.test", action_label: "", action_url: "" };
const originalFetch = global.fetch;
const mockFetch = jest.fn();

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string, options?: RequestInit) => ({
    ok: true,
    json: async () => options?.method === "PUT" ? { data: {} } : url === "/api/admin/agentic-app-guidance"
      ? { data: { items: [{ appId: "example", displayName: "Example App" }] } }
      : { data: { guides: [guide] } },
  }));
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => { global.fetch = originalFetch; });

test("saves and removes the optional Webex logo for an existing guide", async () => {
  render(<ConnectionGuidanceSettings />);
  await screen.findByRole("option", { name: "Example App" });
  fireEvent.change(screen.getByRole("combobox", { name: "Agentic App" }), { target: { value: "example" } });
  const logo = await screen.findByRole("combobox", { name: "Button logo" });
  await waitFor(() => expect(logo).not.toBeDisabled());
  expect(logo).toHaveValue("");
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toContain("Webex");

  fireEvent.change(logo, { target: { value: "webex" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connection guidance" }));
  await screen.findByText("Connection guidance saved.");
  const firstSave = mockFetch.mock.calls.find(([, options]) => options?.method === "PUT");
  expect(JSON.parse(firstSave![1].body).guides).toEqual([{ ...guide, logo: "webex" }]);

  fireEvent.change(logo, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connection guidance" }));
  await waitFor(() => expect(mockFetch.mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(2));
  const secondSave = mockFetch.mock.calls.filter(([, options]) => options?.method === "PUT")[1];
  expect(JSON.parse(secondSave[1].body).guides).toEqual([guide]);
});
