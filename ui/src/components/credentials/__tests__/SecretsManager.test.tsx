import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// assisted-by Codex Codex-sonnet-4-6

import { SecretsManager } from "../SecretsManager";

describe("SecretsManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn(async (url, init) => {
      if (String(url) === "/api/dynamic-agents/teams") {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: [
              { _id: "team-1", slug: "platform-team", name: "Platform Team" },
              { _id: "team-2", slug: "security-team", name: "Security Team" },
            ],
          }),
        } as Response;
      }

      if (init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: {
              id: "secret-2",
              name: "New token",
              type: "bearer_token",
              maskedPreview: "new_...alue",
              sharedWithTeams: [],
            },
          }),
        } as Response;
      }

      if (init?.method === "DELETE") {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: { id: "secret-1", deleted: true },
          }),
        } as Response;
      }

      if (init?.method === "PATCH" && String(url) === "/api/credentials/secrets/secret-1") {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: {
              id: "secret-1",
              name: "GitHub token",
              type: "bearer_token",
              maskedPreview: "new_...ated",
              sharedWithTeams: ["platform-team"],
              rotatedAt: "2026-06-21T18:00:00.000Z",
            },
          }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({
          success: true,
          data: [
            {
              id: "secret-1",
              name: "GitHub token",
              type: "bearer_token",
              owner: {
                type: "user",
                id: "alice-sub",
                email: "alice@example.test",
                name: "Alice Example",
              },
              createdBy: {
                type: "user",
                id: "alice-sub",
                email: "alice@example.test",
                name: "Alice Example",
              },
              maskedPreview: "ghp_...abcd",
              sharedWithTeams: ["platform-team"],
              usage: [
                {
                  type: "mcp_server",
                  id: "mcp-github",
                  name: "GitHub MCP",
                  location: "Agents > Tools",
                  detail: "env: GITHUB_TOKEN",
                },
              ],
              storage: {
                metadataCollection: "credential_secret_refs",
                payloadCollection: "credential_encrypted_payloads",
                encryption: "AES-256-GCM envelope encryption",
                plaintextReadableByBrowser: false,
                valuePreviewAvailable: true,
              },
              createdAt: "2026-06-20T01:00:00.000Z",
              rotatedAt: "2026-06-20T02:00:00.000Z",
            },
          ],
        }),
      } as Response;
    }) as jest.Mock;
  });

  it("renders the encrypted masked preview and never displays raw credential values", async () => {
    render(<SecretsManager />);

    expect(await screen.findByText("GitHub token")).toBeInTheDocument();
    expect(screen.getByText("Preview ghp_...abcd")).toBeInTheDocument();
    expect(screen.queryByText("ghp_raw_token_value")).not.toBeInTheDocument();
  });

  it("opens safe details with the masked preview without exposing the secret value", async () => {
    const user = userEvent.setup();
    render(<SecretsManager />);

    expect(await screen.findByText("GitHub token")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /view details for github token/i }));

    const dialog = await screen.findByRole("dialog", { name: /github token details/i });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/saved value stays protected; this preview is masked/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/masked preview/i)).toBeInTheDocument();
    expect(within(dialog).getByText("ghp_...abcd")).toBeInTheDocument();
    expect(within(dialog).getByText("Alice Example")).toBeInTheDocument();
    expect(within(dialog).getByText(/Shared with/i)).toBeInTheDocument();
    expect(within(dialog).getByText("platform-team")).toBeInTheDocument();
    expect(within(dialog).getByText(/GitHub MCP/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /secret protection details/i })).toBeInTheDocument();
    expect(within(dialog).queryByText(/credential_secret_refs/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/credential_encrypted_payloads/)).not.toBeInTheDocument();
    await user.hover(within(dialog).getByRole("button", { name: /secret protection details/i }));
    expect(await screen.findByText("Secret protection")).toBeInTheDocument();
    expect(screen.getByText(/masked preview is a protected hint/i)).toBeInTheDocument();
    expect(screen.getByText(/never shown in the browser/i)).toBeInTheDocument();
    expect(screen.queryByText(/Saved record: credential_secret_refs/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Protected value: credential_encrypted_payloads/)).not.toBeInTheDocument();
    expect(screen.queryByText(/AES-256-GCM envelope encryption/)).not.toBeInTheDocument();
    expect(screen.queryByText("ghp_raw_token_value")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /preview|reveal|copy secret/i })).not.toBeInTheDocument();
  });

  it("submits raw values only to the create endpoint and clears the input", async () => {
    const user = userEvent.setup();
    render(<SecretsManager />);

    await screen.findByText("GitHub token");
    expect(screen.queryByLabelText(/secret value/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /add secret/i }));
    await user.type(screen.getByLabelText(/name/i), "New token");
    const secretInput = screen.getByLabelText("Secret value", {
      selector: "input",
    }) as HTMLInputElement;
    expect(secretInput.type).toBe("password");
    await user.type(secretInput, "new-token-value");
    await user.click(screen.getByRole("button", { name: /show secret value before saving/i }));
    expect(secretInput.type).toBe("text");
    expect(secretInput).toHaveValue("new-token-value");
    await user.click(screen.getByRole("button", { name: /hide secret value before saving/i }));
    expect(secretInput.type).toBe("password");
    await user.click(screen.getByRole("button", { name: /save secret/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/credentials/secrets",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("new-token-value"),
        }),
      );
    });
    expect(screen.queryByLabelText(/secret value/i)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("new-token-value")).not.toBeInTheDocument();
  });

  it("clears the pre-save peek when the add dialog closes", async () => {
    const user = userEvent.setup();
    render(<SecretsManager />);

    await screen.findByText("GitHub token");
    await user.click(screen.getByRole("button", { name: /add secret/i }));
    const secretInput = screen.getByLabelText("Secret value", {
      selector: "input",
    }) as HTMLInputElement;
    await user.type(screen.getByLabelText(/name/i), "Temporary token");
    await user.type(secretInput, "temporary-secret-value");
    await user.click(screen.getByRole("button", { name: /show secret value before saving/i }));
    expect(secretInput.type).toBe("text");

    await user.click(screen.getByRole("button", { name: /^close$/i }));
    expect(screen.queryByLabelText(/secret value/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /add secret/i }));
    const reopenedSecretInput = screen.getByLabelText("Secret value", {
      selector: "input",
    }) as HTMLInputElement;
    expect(reopenedSecretInput.type).toBe("password");
    expect(reopenedSecretInput).toHaveValue("");
    expect(screen.getByLabelText(/name/i)).toHaveValue("");
  });

  it("rotates an existing secret with a pre-save peek and updates the masked preview", async () => {
    const user = userEvent.setup();
    render(<SecretsManager />);

    expect(await screen.findByText("GitHub token")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /rotate github token/i }));

    const panel = await screen.findByRole("region", { name: /github token rotation/i });
    const rotateInput = within(panel).getByLabelText("New secret value", {
      selector: "input",
    }) as HTMLInputElement;
    expect(rotateInput.type).toBe("password");
    await user.type(rotateInput, "rotated-secret-value");
    await user.click(within(panel).getByRole("button", { name: /show new secret value before saving/i }));
    expect(rotateInput.type).toBe("text");
    expect(rotateInput).toHaveValue("rotated-secret-value");
    await user.click(within(panel).getByRole("button", { name: /save new value/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/credentials/secrets/secret-1",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining('"action":"rotate"'),
        }),
      );
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/credentials/secrets/secret-1",
      expect.objectContaining({
        method: "PATCH",
        body: expect.stringContaining("rotated-secret-value"),
      }),
    );
    expect(screen.queryByRole("region", { name: /github token rotation/i })).not.toBeInTheDocument();
    expect(screen.getByText("Preview new_...ated")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("rotated-secret-value")).not.toBeInTheDocument();
  });

  it("expands team sharing inline with the shared team selected", async () => {
    const user = userEvent.setup();
    render(<SecretsManager />);

    expect(await screen.findByText("GitHub token")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /github token team access/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Team access enabled/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /share github token/i }));

    const panel = await screen.findByRole("region", { name: /github token team access/i });
    expect(panel).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /share github token/i })).not.toBeInTheDocument();
    expect(within(panel).getByRole("combobox", { name: /team access/i })).toHaveTextContent("Platform Team");
    expect(within(panel).getByRole("combobox", { name: /team access/i })).toHaveTextContent("team:platform-team");
    expect(within(panel).getByText(/Choose a team that can use this saved secret/i)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /revoke access/i })).toBeInTheDocument();
    expect(screen.queryByText("Shared with Platform Team")).not.toBeInTheDocument();
  });

  it("deletes a secret after inline row confirmation", async () => {
    const user = userEvent.setup();
    const confirmSpy = jest.spyOn(window, "confirm");
    render(<SecretsManager />);

    expect(await screen.findByText("GitHub token")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /delete github token/i }));

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/delete github token\?/i)).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalledWith(
      "/api/credentials/secrets/secret-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    await user.click(screen.getByRole("button", { name: /confirm delete github token/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/credentials/secrets/secret-1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
    expect(screen.queryByText("GitHub token")).not.toBeInTheDocument();
  });
});
