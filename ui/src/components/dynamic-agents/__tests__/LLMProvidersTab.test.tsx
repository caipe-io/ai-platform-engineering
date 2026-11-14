import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LLMProvidersTab } from "../LLMProvidersTab";

function response(data: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () =>
      status < 400 ? { success: true, data } : { error: data },
  } as Response;
}
const secrets = [
  {
    id: "example-key",
    name: "Primary key",
    type: "api_key",
    maskedPreview: "protected",
  },
  { id: "example-endpoint", name: "Primary endpoint", type: "custom" },
];
let ready = true;
let requests: { path: string; body: Record<string, unknown> }[];
beforeEach(() => {
  ready = true;
  requests = [];
  global.fetch = jest.fn(async (url, init) => {
    const path = String(url);
    if (init?.body)
      requests.push({ path, body: JSON.parse(String(init.body)) });
    if (path === "/api/credentials/secrets") return response(secrets);
    if (path === "/api/credentials/llm-providers")
      return response({ bindings: {} });
    if (path === "/api/llm-models/connections")
      return response({
        connections: [],
        models: [],
        can_manage: true,
        runtime_supported: ready,
      });
    if (path === "/api/llm-models/test")
      return response({
        success: true,
        category: "success",
        message: "Connected",
        elapsed_ms: 15,
      });
    return response("Unexpected request", 404);
  }) as jest.Mock;
});
async function open() {
  const user = userEvent.setup();
  render(<LLMProvidersTab />);
  const connect = await screen.findByRole("button", {
    name: "Connect OpenAI / Compatible",
  });
  await waitFor(() => expect(connect).toBeEnabled());
  await user.click(connect);
  await user.type(screen.getByLabelText("Connection name"), "Primary gateway");
  await user.type(
    screen.getByLabelText("Model IDs"),
    "example-model\nsecondary-model",
  );
  return user;
}
it("creates a named connection and multiple model registrations in one request using saved references", async () => {
  const user = await open();
  for (const [label, name] of [
    ["API Key", "Primary key"],
    ["OpenAI Endpoint URL", "Primary endpoint"],
  ]) {
    await user.click(
      screen.getByRole("combobox", { name: label, exact: true }),
    );
    await user.click(screen.getByRole("option", { name: new RegExp(name) }));
  }
  await user.click(screen.getByRole("button", { name: "Save Connection" }));
  await waitFor(() =>
    expect(
      requests.some((entry) => entry.path === "/api/llm-models/connections"),
    ).toBe(true),
  );
  expect(
    requests.find((entry) => entry.path === "/api/llm-models/connections")
      ?.body,
  ).toEqual(
    expect.objectContaining({
      name: "Primary gateway",
      models: ["example-model", "secondary-model"],
      fields: { api_key: "example-key", endpoint: "example-endpoint" },
      values: {},
    }),
  );
  expect(requests.some((entry) => entry.path.includes("/retrieve"))).toBe(
    false,
  );
});
it("tests new values before saving and does not create secrets or models", async () => {
  const user = await open();
  await user.selectOptions(
    screen.getByLabelText("Provider type"),
    "openai-compatible",
  );
  await user.selectOptions(screen.getByLabelText("API Key source"), "new");
  await user.type(
    screen.getByLabelText("API Key", { exact: true }),
    "example-private-key",
  );
  await user.selectOptions(
    screen.getByLabelText("OpenAI Endpoint URL source"),
    "new",
  );
  await user.type(
    screen.getByLabelText("OpenAI Endpoint URL", { exact: true }),
    "https://example.test/v1",
  );
  await user.click(screen.getByRole("button", { name: "Test Connection" }));
  expect(await screen.findByText(/Connected ·/)).toBeInTheDocument();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toEqual({
    path: "/api/llm-models/test",
    body: {
      upstream_model_id: "example-model",
      draft: {
        provider: "openai-compatible",
        auth_mode: "secrets",
        fields: {},
        values: {
          api_key: "example-private-key",
          endpoint: "https://example.test/v1",
        },
      },
    },
  });
  expect(
    screen.getByText("Saved securely in Saved Secrets"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: /Manage Saved Secrets/ }),
  ).toBeInTheDocument();
});
it("disables creation when the runtime cannot resolve saved model connections", async () => {
  ready = false;
  render(<LLMProvidersTab />);
  await screen.findByText(/Creating saved connections requires/);
  expect(
    screen.getByRole("button", { name: "Connect OpenAI / Compatible" }),
  ).toBeDisabled();
});
it("shows a failure diagnostic with details instead of losing the provider explanation", async () => {
  const user = await open();
  (global.fetch as jest.Mock).mockImplementationOnce(async () => ({
    ok: true,
    json: async () => ({
      success: false,
      category: "authentication",
      message: "Provider rejected credentials",
      status_code: 401,
      elapsed_ms: 12,
    }),
  }));
  await user.click(screen.getByRole("button", { name: "Test Connection" }));
  expect(await screen.findByText(/Connection failed/)).toBeInTheDocument();
  expect(screen.getByText("Provider rejected credentials")).toBeInTheDocument();
});
