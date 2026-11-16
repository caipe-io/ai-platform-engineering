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

async function openEditor() {
  render(<ConnectionGuidanceSettings />);
  await screen.findByRole("option", { name: "Example App" });
  fireEvent.change(screen.getByRole("combobox", { name: "Agentic App" }), { target: { value: "example" } });
}

test("loads a saved Webex logo and sends the read revision when saving", async () => {
  mockFetch.mockImplementation(async (url: string, options?: RequestInit) => ({ ok: true, json: async () => options?.method === "PUT" ? { data: { revision: "next" } } : url === "/api/admin/agentic-app-guidance" ? { data: { items: [{ appId: "example", displayName: "Example App" }] } } : { data: { guides: [{ ...guide, logo: "webex" }], revision: "initial" } } }));
  await openEditor();
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Button logo" })).toHaveValue("webex"));
  fireEvent.change(screen.getByRole("textbox", { name: "Button label" }), { target: { value: "Connect" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connection guidance" }));
  await screen.findByText("Connection guidance saved.");
  expect(JSON.parse(mockFetch.mock.calls.find(([, options]) => options?.method === "PUT")![1].body).revision).toBe("initial");
});

test("retries an initial load failure", async () => {
  const fallback = mockFetch.getMockImplementation()!;
  let fail = true;
  mockFetch.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.includes("?editor=true") && fail) { fail = false; return { ok: false }; }
    return fallback(url, options);
  });
  await openEditor();
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Reload connection guidance" }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Button logo" })).toBeEnabled());
});

test("uses an unused channel ID after a guide is removed", async () => {
  await openEditor();
  const add = await screen.findByRole("button", { name: "Add connection guide" });
  await waitFor(() => expect(add).toBeEnabled());
  fireEvent.click(add); fireEvent.click(add); fireEvent.click(add);
  fireEvent.click(screen.getAllByRole("button", { name: "Remove guide" })[2]);
  fireEvent.click(add);
  const ids = screen.getAllByRole("textbox", { name: "Channel ID" }).map(input => (input as HTMLInputElement).value);
  expect(new Set(ids).size).toBe(ids.length);
});

test("keeps a conflicted edit until the administrator explicitly reloads", async () => {
  const fallback = mockFetch.getMockImplementation()!;
  mockFetch.mockImplementation(async (url: string, options?: RequestInit) => options?.method === "PUT" ? { ok: false, status: 409, json: async () => ({ error: "Connection guidance changed." }) } : fallback(url, options));
  await openEditor();
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Button label" })).toBeEnabled());
  fireEvent.change(screen.getByRole("textbox", { name: "Button label" }), { target: { value: "Unsaved edit" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connection guidance" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("textbox", { name: "Button label" })).toHaveValue("Unsaved edit");
  expect(screen.getByRole("button", { name: "Save connection guidance" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Reload connection guidance" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Button label" })).toHaveValue(guide.label));
});
