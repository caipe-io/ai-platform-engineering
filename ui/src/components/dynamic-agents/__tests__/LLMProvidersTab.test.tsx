import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// assisted-by Codex Codex-sonnet-4-6

import { LLMProvidersTab } from "../LLMProvidersTab";

describe("LLMProvidersTab", () => {
  let savedSecrets: { id: string; name: string; type: string; maskedPreview?: string }[];
  beforeEach(() => {
    jest.clearAllMocks();
    savedSecrets = [{ id: "secret-1", name: "llm:openai:api_key", type: "api_key", maskedPreview: "protected" }];
    global.fetch = jest.fn(async (url, init) => {
      const href = String(url);
      if (href.includes("/api/llm-models")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: {
              items: [
                { _id: "gpt-4o", model_id: "gpt-4o", name: "GPT-4o", provider: "openai" },
                {
                  _id: "global.anthropic.claude-sonnet-4-6",
                  model_id: "global.anthropic.claude-sonnet-4-6",
                  name: "Claude Sonnet",
                  provider: "aws-bedrock",
                },
              ],
            },
          }),
        } as Response;
      }
      if (href.includes("/api/credentials/secrets") && (!init || init.method === "GET")) {
        return {
          ok: true,
          json: async () => ({
            data: savedSecrets,
          }),
        } as Response;
      }
      if (href.includes("/api/credentials/secrets") && init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({ data: { id: "secret-2", name: "llm:aws-bedrock:secret_access_key" } }),
        } as Response;
      }
      return { ok: false, json: async () => ({ error: "unexpected request" }) } as Response;
    }) as jest.Mock;
  });

  it("shows provider status cards without mixing in the model registry", async () => {
    render(<LLMProvidersTab />);

    expect(await screen.findByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("AWS Bedrock")).toBeInTheDocument();
    expect(await screen.findByText("Partly saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(screen.queryByText("LLM models content")).not.toBeInTheDocument();
  });

  it("creates provider credential secrets using the shared credential store", async () => {
    const user = userEvent.setup();
    render(<LLMProvidersTab />);

    await user.click(await screen.findByRole("button", { name: /connect aws bedrock/i }));
    await user.type(screen.getByLabelText(/access key id/i), "aws-access-key-test");
    await user.type(screen.getByLabelText(/secret access key/i), "secret-value");
    await user.type(screen.getByLabelText(/region/i), "us-east-1");
    await user.click(screen.getByRole("button", { name: /save connection/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/credentials/secrets",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("llm:aws-bedrock:secret_access_key"),
        }),
      );
    });
  });
  it("accepts and protects both OpenAI endpoint and API key", async () => {
    savedSecrets = [];
    const user = userEvent.setup();
    render(<LLMProvidersTab />);
    await user.click(await screen.findByRole("button", { name: "Connect OpenAI" }));
    const dialog = screen.getByRole("dialog", { name: "Configure OpenAI" });
    expect(within(dialog).getByLabelText("OpenAI Endpoint URL")).toHaveAttribute("type", "url");
    expect(within(dialog).getByLabelText("API Key")).toHaveAttribute("type", "password");
    expect(within(dialog).getByText("Saved securely in Saved Secrets")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /Manage Saved Secrets/ })).toHaveAttribute("href", "/credentials/secrets");
    expect(within(dialog).getByRole("link", { name: /Manage Saved Secrets/ })).toHaveAttribute("target", "_blank");
    expect(within(dialog).getByText(/grant a team access/)).toBeInTheDocument();
    expect(within(dialog).getByText(/does not revoke the key/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("OpenAI Endpoint URL"), "https://llm.example.com/v1");
    await user.type(within(dialog).getByLabelText("API Key"), "example-api-key");
    await user.click(within(dialog).getByRole("button", { name: "Save Connection" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const posts = (global.fetch as jest.Mock).mock.calls.filter(([,init]) => init?.method === "POST").map(([,init]) => JSON.parse(init.body));
    expect(posts).toEqual([
      expect.objectContaining({ name: "llm:openai:endpoint", type: "custom", value: "https://llm.example.com/v1" }),
      expect.objectContaining({ name: "llm:openai:api_key", type: "api_key", value: "example-api-key" }),
    ]);
    expect(screen.getByRole("status")).toHaveTextContent("OpenAI details saved");
  });

  it("adds a missing endpoint without recreating an existing key", async () => {
    const user = userEvent.setup();
    render(<LLMProvidersTab />);
    await user.click(await screen.findByRole("button", { name: "Connect OpenAI" }));
    expect(screen.getByLabelText("API Key")).toBeDisabled();
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    await user.type(screen.getByLabelText("OpenAI Endpoint URL"), "https://llm.example.com/v1");
    await user.click(screen.getByRole("button", { name: "Save Connection" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const posts = (global.fetch as jest.Mock).mock.calls.filter(([,init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1].body).name).toBe("llm:openai:endpoint");
  });

  it.each(["ftp://llm.example.com/v1", "https://example-user:example-password@llm.example.com/v1"])("rejects an unsafe endpoint: %s", async (url) => {
    const user = userEvent.setup();
    render(<LLMProvidersTab />);
    await user.click(await screen.findByRole("button", { name: "Connect OpenAI" }));
    await user.type(screen.getByLabelText("OpenAI Endpoint URL"), url);
    await user.click(screen.getByRole("button", { name: "Save Connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP or HTTPS URL without embedded credentials");
    expect((global.fetch as jest.Mock).mock.calls.filter(([,init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("does not duplicate an endpoint when retrying a failed key save", async () => {
    savedSecrets = [];
    const normalFetch = global.fetch;
    let failKey = true;
    global.fetch = jest.fn(async (url, init) => {
      if (init?.method === "POST" && JSON.parse(String(init.body)).name === "llm:openai:api_key" && failKey) {
        return { ok: false, json: async () => ({ error: "Example save failure" }) } as Response;
      }
      return normalFetch(url, init);
    });
    const user = userEvent.setup();
    render(<LLMProvidersTab />);
    await user.click(await screen.findByRole("button", { name: "Connect OpenAI" }));
    await user.type(screen.getByLabelText("OpenAI Endpoint URL"), "https://llm.example.com/v1");
    await user.type(screen.getByLabelText("API Key"), "example-api-key");
    await user.click(screen.getByRole("button", { name: "Save Connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Example save failure");
    expect(screen.getByLabelText("OpenAI Endpoint URL")).toBeDisabled();
    failKey = false;
    await user.click(screen.getByRole("button", { name: "Save Connection" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const posts = (global.fetch as jest.Mock).mock.calls.filter(([,init]) => init?.method === "POST").map(([,init]) => JSON.parse(init.body));
    expect(posts.filter((body) => body.name === "llm:openai:endpoint")).toHaveLength(1);
    expect(posts.filter((body) => body.name === "llm:openai:api_key")).toHaveLength(2);
  });

  it("refreshes saved metadata when closing a partially saved connection", async () => {
    savedSecrets = [];
    const normalFetch = global.fetch;
    global.fetch = jest.fn(async (url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.name === "llm:openai:api_key") return { ok: false, json: async () => ({ error: "Example save failure" }) } as Response;
        savedSecrets.push({ id: "example-endpoint", name: body.name, type: body.type });
      }
      return normalFetch(url, init);
    });
    const user = userEvent.setup();
    render(<LLMProvidersTab />);
    await user.click(await screen.findByRole("button", { name: "Connect OpenAI" }));
    await user.type(screen.getByLabelText("OpenAI Endpoint URL"), "https://llm.example.com/v1");
    await user.type(screen.getByLabelText("API Key"), "example-api-key");
    await user.click(screen.getByRole("button", { name: "Save Connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Example save failure");
    await user.click(screen.getByRole("button", { name: "Close", exact: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Connect OpenAI" }));
    expect(screen.getByLabelText("OpenAI Endpoint URL")).toBeDisabled();
    expect(screen.getByLabelText("API Key")).toBeEnabled();
  });

});
