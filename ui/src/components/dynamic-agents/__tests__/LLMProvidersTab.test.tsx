import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LLMProvidersTab } from "../LLMProvidersTab";
import type {
  ProviderSecretBindings,
  SavedProviderSecret,
} from "@/lib/llm-provider-credentials";

type User = ReturnType<typeof userEvent.setup>;
function response(data: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () =>
      status < 400 ? { success: true, data } : { error: data },
  } as Response;
}
async function pick(user: User, field: string, name: string) {
  await user.click(screen.getByRole("combobox", { name: field, exact: true }));
  await user.click(screen.getByRole("option", { name: new RegExp(name) }));
}

describe("LLMProvidersTab", () => {
  let secrets: SavedProviderSecret[];
  let bindings: ProviderSecretBindings;
  beforeEach(() => {
    jest.clearAllMocks();
    secrets = [
      {
        id: "example-key",
        name: "Primary key",
        type: "api_key",
        maskedPreview: "protected",
      },
      { id: "example-endpoint", name: "Primary endpoint", type: "custom" },
      { id: "example-version", name: "Primary version", type: "custom" },
      { id: "example-region", name: "Primary region", type: "custom" },
    ];
    bindings = {};
    global.fetch = jest.fn(async (url, init) => {
      const path = String(url);
      if (path === "/api/credentials/secrets") {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          const secret = {
            id: `created-${secrets.length}`,
            name: body.name,
            type: body.type,
          };
          secrets = [...secrets, secret];
          return response(secret, 201);
        }
        return response(secrets);
      }
      if (path === "/api/credentials/llm-providers") {
        if (init?.method === "PATCH") {
          const body = JSON.parse(String(init.body));
          bindings = { ...bindings, [body.provider]: body.fields };
          return response(body);
        }
        return response({ bindings });
      }
      return response("Unexpected request", 404);
    }) as jest.Mock;
  });

  it("shows every supported provider without depending on registered models", async () => {
    render(<LLMProvidersTab />);
    for (const name of [
      "OpenAI / Compatible",
      "Anthropic Claude",
      "AWS Bedrock",
      "Azure OpenAI",
      "Google Gemini",
    ]) {
      expect(
        await screen.findByRole("button", { name: `Connect ${name}` }),
      ).toBeInTheDocument();
    }
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Connect OpenAI / Compatible" }),
      ).toBeEnabled(),
    );
    expect(
      screen.getByText(/any OpenAI-compatible endpoint/),
    ).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/llm-models"),
    );
  });

  it("saves selected references without copying or retrieving secret values", async () => {
    const user = userEvent.setup();
    render(<LLMProvidersTab />);
    await user.click(
      await screen.findByRole("button", {
        name: "Connect OpenAI / Compatible",
      }),
    );
    await pick(user, "OpenAI Endpoint URL", "Primary endpoint");
    await pick(user, "API Key", "Primary key");
    await user.click(screen.getByRole("button", { name: "Save Connection" }));
    await waitFor(() =>
      expect(bindings.openai).toEqual({
        endpoint: "example-endpoint",
        api_key: "example-key",
      }),
    );
    expect(
      (global.fetch as jest.Mock).mock.calls.filter(
        ([, init]) => init?.method === "POST",
      ),
    ).toHaveLength(0);
    expect(
      (global.fetch as jest.Mock).mock.calls.some(([url]) =>
        String(url).includes("retrieve"),
      ),
    ).toBe(false);
  });

  it("creates encrypted values when no saved secrets exist and binds returned ids", async () => {
    secrets = [];
    const user = userEvent.setup();
    render(<LLMProvidersTab />);
    await user.click(
      await screen.findByRole("button", {
        name: "Connect OpenAI / Compatible",
      }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText("Saved securely in Saved Secrets"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", { name: /Manage Saved Secrets/ }),
    ).toHaveAttribute("target", "_blank");
    await user.type(
      screen.getByLabelText("OpenAI Endpoint URL", { exact: true }),
      "https://llm.example.com/v1",
    );
    await user.type(
      screen.getByLabelText("API Key", { exact: true }),
      "example-api-key",
    );
    await user.click(screen.getByRole("button", { name: "Save Connection" }));
    await waitFor(() =>
      expect(bindings.openai).toEqual({
        endpoint: "created-0",
        api_key: "created-1",
      }),
    );
    const posts = (global.fetch as jest.Mock).mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(init.body));
    expect(posts).toEqual([
      expect.objectContaining({
        name: "llm:openai:endpoint",
        value: "https://llm.example.com/v1",
      }),
      expect.objectContaining({
        name: "llm:openai:api_key",
        value: "example-api-key",
      }),
    ]);
  });

  it("can switch from saved to new input without revealing the old value", async () => {
    const user = userEvent.setup();
    render(<LLMProvidersTab />);
    await user.click(
      await screen.findByRole("button", { name: "Connect Anthropic Claude" }),
    );
    await pick(user, "API Key", "Primary key");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "API Key source" }),
      "new",
    );
    expect(screen.getByLabelText("API Key", { exact: true })).toHaveAttribute(
      "type",
      "password",
    );
    expect(screen.getByLabelText("API Key", { exact: true })).toHaveValue("");
  });

  it.each(["Anthropic Claude", "Google Gemini", "Groq"])(
    "reuses saved keys for %s",
    async (name) => {
      const user = userEvent.setup();
      render(<LLMProvidersTab />);
      await user.click(
        await screen.findByRole("button", { name: `Connect ${name}` }),
      );
      await pick(user, "API Key", "Primary key");
      await user.click(screen.getByRole("button", { name: "Save Connection" }));
      const id =
        name === "Anthropic Claude"
          ? "anthropic-claude"
          : name === "Groq"
            ? "groq"
            : "google-gemini";
      await waitFor(() =>
        expect(bindings[id]).toEqual({ api_key: "example-key" }),
      );
    },
  );

  it("reuses Azure endpoint, version, and key references", async () => {
    const user = userEvent.setup();
    render(<LLMProvidersTab />);
    await user.click(
      await screen.findByRole("button", { name: "Connect Azure OpenAI" }),
    );
    await pick(user, "Azure Endpoint URL", "Primary endpoint");
    await pick(user, "API Version", "Primary version");
    await pick(user, "API Key", "Primary key");
    await user.click(screen.getByRole("button", { name: "Save Connection" }));
    await waitFor(() =>
      expect(bindings["azure-openai"]).toEqual({
        endpoint: "example-endpoint",
        api_version: "example-version",
        api_key: "example-key",
      }),
    );
  });

  it("supports Bedrock deployment IAM without storing keys", async () => {
    const user = userEvent.setup();
    render(<LLMProvidersTab />);
    await user.click(
      await screen.findByRole("button", { name: "Connect AWS Bedrock" }),
    );
    expect(screen.getByLabelText("Authentication")).toHaveValue("deployment");
    await user.click(screen.getByRole("button", { name: "Save Connection" }));
    await waitFor(() => expect(bindings["aws-bedrock"]).toEqual({}));
    expect(
      (global.fetch as jest.Mock).mock.calls.filter(
        ([, init]) => init?.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("supports saved Bedrock access keys, optional session token, and region", async () => {
    secrets.push({
      id: "example-access",
      name: "Primary access id",
      type: "custom",
    });
    const user = userEvent.setup();
    render(<LLMProvidersTab />);
    await user.click(
      await screen.findByRole("button", { name: "Connect AWS Bedrock" }),
    );
    await user.selectOptions(screen.getByLabelText("Authentication"), "keys");
    await pick(user, "Access Key ID", "Primary access id");
    await pick(user, "Secret Access Key", "Primary key");
    await pick(user, "Region", "Primary region");
    await user.click(screen.getByRole("button", { name: "Save Connection" }));
    await waitFor(() =>
      expect(bindings["aws-bedrock"]).toEqual({
        access_key_id: "example-access",
        secret_access_key: "example-key",
        region: "example-region",
      }),
    );
  });

  it("does not create duplicates when retrying after a binding save failure", async () => {
    secrets = [];
    let fail = true;
    const normalFetch = global.fetch;
    global.fetch = jest.fn(async (url, init) =>
      String(url).includes("llm-providers") && init?.method === "PATCH" && fail
        ? response("Example save failure", 503)
        : normalFetch(url, init),
    );
    const user = userEvent.setup();
    render(<LLMProvidersTab />);
    await user.click(
      await screen.findByRole("button", { name: "Connect Anthropic Claude" }),
    );
    await user.type(
      screen.getByLabelText("API Key", { exact: true }),
      "example-api-key",
    );
    await user.click(screen.getByRole("button", { name: "Save Connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Example save failure",
    );
    fail = false;
    await user.click(screen.getByRole("button", { name: "Save Connection" }));
    await waitFor(() =>
      expect(bindings["anthropic-claude"]).toEqual({ api_key: "created-0" }),
    );
    expect(
      (global.fetch as jest.Mock).mock.calls.filter(
        ([, init]) => init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("reports metadata failures with retry instead of silently showing no secrets", async () => {
    const normalFetch = global.fetch;
    let fail = true;
    global.fetch = jest.fn(async (url, init) =>
      String(url) === "/api/credentials/secrets" && fail
        ? response("Example unavailable", 503)
        : normalFetch(url, init),
    );
    const user = userEvent.setup();
    render(<LLMProvidersTab />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Example unavailable",
    );
    expect(
      screen.getByRole("button", { name: "Connect OpenAI / Compatible" }),
    ).toBeDisabled();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Connect OpenAI / Compatible" }),
      ).toBeEnabled(),
    );
  });
  it("explains Vertex deployment identity without asking for an API key", async () => {
    const user = userEvent.setup();
    render(<LLMProvidersTab />);
    await user.click(
      await screen.findByRole("button", {
        name: "View Google Vertex AI requirements",
      }),
    );
    expect(
      screen.getByText(/Vertex AI uses Application Default Credentials/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save Connection" }),
    ).not.toBeInTheDocument();
  });
  it("rejects a new endpoint with embedded credentials before saving any values", async () => {
    const user = userEvent.setup(); render(<LLMProvidersTab />);
    await user.click(await screen.findByRole("button", { name: "Connect OpenAI / Compatible" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "OpenAI Endpoint URL source" }), "new");
    await user.type(screen.getByLabelText("OpenAI Endpoint URL", { exact: true }), "https://example-user:example-password@llm.example.com/v1");
    await pick(user, "API Key", "Primary key");
    await user.click(screen.getByRole("button", { name: "Save Connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("without embedded credentials");
    expect((global.fetch as jest.Mock).mock.calls.filter(([,init]) => init?.method === "POST" || init?.method === "PATCH")).toHaveLength(0);
  });

});
