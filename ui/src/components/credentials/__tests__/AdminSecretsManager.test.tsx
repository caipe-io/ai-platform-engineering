import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// assisted-by Codex Codex-sonnet-4-6

import { AdminSecretsManager } from "../AdminSecretsManager";

describe("AdminSecretsManager", () => {
  beforeEach(() => {
    global.fetch = jest.fn(async (url, init) => {
      if (String(url).includes("/api/admin/credentials/audit")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: [
              {
                action: "credential.create",
                result: "success",
                ts: "2026-06-20T01:00:00.000Z",
                actor: {
                  type: "user",
                  id: "alice-sub",
                  email: "alice@example.test",
                  name: "Alice Example",
                },
                resource: { type: "secret_ref", id: "secret-1" },
              },
              {
                action: "credential.rotate",
                result: "success",
                ts: "2026-06-20T02:00:00.000Z",
                actor: { type: "user", id: "bob-sub", email: "bob@example.test" },
                resource_ref: "secret_ref:secret-other",
              },
            ],
          }),
        } as Response;
      }
      if (init?.method === "PATCH") {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: {
              id: "secret-1",
              name: "Renamed token",
              description: "Updated metadata",
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
              type: "bearer_token",
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
              createdAt: "2026-06-20T12:00:00.000Z",
              rotatedAt: "2026-06-20T02:00:00.000Z",
            },
          }),
        } as Response;
      }
      if (String(url).includes("/secret-1")) {
        return { ok: true, json: async () => ({ success: true, data: { deleted: true } }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: [
            {
              id: "secret-1",
              name: "GitHub token",
              description: "GitHub automation token",
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
              type: "bearer_token",
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
              createdAt: "2026-06-20T12:00:00.000Z",
              rotatedAt: "2026-06-20T02:00:00.000Z",
            },
          ],
        }),
      } as Response;
    }) as jest.Mock;
  });

  it("lists all secret metadata and deletes through admin route", async () => {
    const user = userEvent.setup();
    render(<AdminSecretsManager />);

    expect(await screen.findByText("GitHub token")).toBeInTheDocument();
    expect(screen.queryByText("user:alice-sub")).not.toBeInTheDocument();
    expect(screen.getByText("Alice Example")).toBeInTheDocument();
    expect(screen.getByText("Preview ...bcd")).toBeInTheDocument();
    expect(screen.queryByText(/ghp_/)).not.toBeInTheDocument();
    expect(screen.getByText("Shared with 1 team")).toBeInTheDocument();
    expect(screen.getByText("Used in 1 place")).toBeInTheDocument();
    expect(screen.queryByText(/Created by Alice Example/)).not.toBeInTheDocument();
    expect(screen.queryByText("platform-team")).not.toBeInTheDocument();
    expect(screen.queryByText(/GitHub MCP/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /secret protection details/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Recent activity")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /more details/i }));

    expect(screen.getAllByText("Alice Example").length).toBeGreaterThan(0);
    expect(screen.getByText(/^Created \d/)).toBeInTheDocument();
    expect(screen.getByText("platform-team")).toBeInTheDocument();
    expect(screen.getByText(/GitHub MCP/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /secret protection details/i })).toBeInTheDocument();
    expect(screen.queryByText(/credential_secret_refs/)).not.toBeInTheDocument();
    expect(screen.queryByText(/credential_encrypted_payloads/)).not.toBeInTheDocument();
    await user.hover(screen.getByRole("button", { name: /secret protection details/i }));
    expect(await screen.findByText("Secret protection")).toBeInTheDocument();
    expect(screen.getByText(/masked preview is a protected hint/i)).toBeInTheDocument();
    expect(screen.getByText(/never shown in the browser/i)).toBeInTheDocument();
    expect(screen.queryByText(/Saved record: credential_secret_refs/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Protected value: credential_encrypted_payloads/)).not.toBeInTheDocument();
    expect(screen.queryByText(/AES-256-GCM envelope encryption/)).not.toBeInTheDocument();
    expect(screen.getByText("Recent activity")).toBeInTheDocument();
    expect(screen.getByText("Secret added")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByText("credential.create")).not.toBeInTheDocument();
    expect(screen.queryByText("credential.rotate")).not.toBeInTheDocument();
    expect(screen.queryByText("ghp_raw_token_value")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /edit/i }));
    await user.clear(screen.getByLabelText(/name/i));
    await user.type(screen.getByLabelText(/name/i), "Renamed token");
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/admin/credentials/secrets/secret-1",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining("Renamed token"),
        }),
      ),
    );

    await user.click(screen.getByRole("button", { name: /delete renamed token/i }));
    expect(screen.getByRole("button", { name: /confirm delete renamed token/i })).toBeInTheDocument();
    expect(
      (global.fetch as jest.Mock).mock.calls.some(
        ([url, init]) => String(url).includes("/api/admin/credentials/secrets/secret-1") && init?.method === "DELETE",
      ),
    ).toBe(false);

    await user.click(screen.getByRole("button", { name: /confirm delete renamed token/i }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/admin/credentials/secrets/secret-1",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });
});
