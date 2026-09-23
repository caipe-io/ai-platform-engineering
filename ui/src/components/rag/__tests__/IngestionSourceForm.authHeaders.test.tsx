/**
 * @jest-environment jsdom
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

// Keep the test focused on form semantics instead of picker popovers.
jest.mock("@/components/ui/team-picker", () => ({
  TeamPicker: ({ value, onChange }: { value: string; onChange: (slug: string) => void }) => (
    <input data-testid="mock-owner-team" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
  TeamMultiPicker: () => <input data-testid="mock-search-teams" />,
}));

jest.mock("@/components/ui/access-subject-picker", () => ({
  AccessSubjectPicker: () => <input data-testid="mock-owner-subject" />,
  AccessSubjectMultiPicker: () => <input data-testid="mock-search-subjects" />,
}));

let mockCredentialsEnabled = true;
jest.mock("@/lib/config", () => {
  const actual = jest.requireActual("@/lib/config");
  return {
    ...actual,
    get config() {
      return { ...actual.config, credentialsEnabled: mockCredentialsEnabled };
    },
  };
});

import { IngestionSourceForm } from "../IngestionSourceForm";

const SECRET_ID = "secret-docs-site";
const SECRET_NAME = "Docs site token";
/** Stands in for a plaintext value that must never reach a request body. */
const PLAINTEXT_SENTINEL = "plaintext-token-must-not-leak";

function jsonOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function previewBody(): Record<string, unknown> {
  const call = (global.fetch as jest.Mock).mock.calls.find(
    ([url, init]: [string, RequestInit | undefined]) =>
      url === "/api/rag/v1/ingest/webloader/preview" && init?.method === "POST",
  );
  expect(call).toBeDefined();
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

function mockFetch(previewResponse?: { ok: boolean; body: unknown }) {
  global.fetch = jest.fn().mockImplementation(async (url: string) => {
    if (url.includes("/api/rbac/ingest-teams")) {
      return jsonOk({ teams: [{ _id: "t1", slug: "author-team", name: "Author Team" }] });
    }
    if (url.includes("/api/dynamic-agents/teams")) {
      return jsonOk({ success: true, data: [] });
    }
    if (url.includes("/api/credentials/secrets")) {
      return jsonOk({
        success: true,
        data: [
          {
            id: SECRET_ID,
            name: SECRET_NAME,
            type: "bearer_token",
            maskedPreview: "oyw9...BxRZ",
            value: PLAINTEXT_SENTINEL,
          },
        ],
      });
    }
    if (url.includes("/api/rag/v1/ingest/webloader/preview")) {
      const preview = previewResponse ?? {
        ok: true,
        body: { items: [{ id: "1", title: "Docs", url: "https://example.com/docs" }] },
      };
      return { ok: preview.ok, status: preview.ok ? 200 : 404, json: async () => preview.body };
    }
    return jsonOk({});
  }) as unknown as typeof fetch;
}

async function renderWebForm(onSave = jest.fn().mockResolvedValue(undefined)) {
  const user = userEvent.setup();
  render(<IngestionSourceForm open onClose={jest.fn()} onSave={onSave} initial={null} />);
  await user.selectOptions(screen.getByLabelText(/source type/i), "web_url");
  await user.type(screen.getByLabelText(/^name/i), "Example Docs");
  await user.type(screen.getByLabelText(/^url/i), "https://example.com/docs");
  return { user, onSave };
}

async function addHeaderWithCredential(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /add header/i }));
  await user.click(await screen.findByRole("combobox", { name: /^credential$/i }));
  await user.click(await screen.findByRole("option", { name: SECRET_NAME }));
}

/**
 * Replaces the template editor's content. The editor is contenteditable, so an
 * edit is a DOM mutation plus an input event rather than keyboard typing, which
 * jsdom does not model for atomic nodes. Passing text without `{{secret}}` is
 * how a test drops the credential chip.
 */
async function setTemplateText(text: string): Promise<void> {
  const editor = screen.getByLabelText(/header value template/i);
  await act(async () => {
    editor.textContent = text;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  mockCredentialsEnabled = true;
  mockFetch();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("<IngestionSourceForm /> — web auth headers", () => {
  it("submits a secret reference and the {{secret}} placeholder, never a plaintext value", async () => {
    const { user, onSave } = await renderWebForm();
    await addHeaderWithCredential(user);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /create source/i }));
    });

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = onSave.mock.calls[0][0] as { settings: { auth_headers: unknown } };
    expect(payload.settings.auth_headers).toEqual([
      {
        header_name: "Authorization",
        value_template: "Bearer {{secret}}",
        secret_ref: SECRET_ID,
      },
    ]);
    expect(JSON.stringify(payload)).not.toContain(PLAINTEXT_SENTINEL);
    expect(JSON.stringify(payload)).not.toContain("oyw9...BxRZ");
  });

  it("keeps a typed header name and a custom value prefix", async () => {
    const { user, onSave } = await renderWebForm();
    await addHeaderWithCredential(user);

    const headerName = screen.getByLabelText("Header name");
    await user.clear(headerName);
    await user.type(headerName, "X-Docs-Token");
    await setTemplateText("Token {{secret}}");

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /create source/i }));
    });

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = onSave.mock.calls[0][0] as { settings: { auth_headers: unknown } };
    expect(payload.settings.auth_headers).toEqual([
      {
        header_name: "X-Docs-Token",
        value_template: "Token {{secret}}",
        secret_ref: SECRET_ID,
      },
    ]);
  });

  it("previews the request, resolving a credential to its trailing hint", async () => {
    const { user } = await renderWebForm();
    expect(screen.queryByTestId("auth-header-request-preview")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /add header/i }));
    await user.click(await screen.findByRole("combobox", { name: /^credential$/i }));
    await user.click(await screen.findByRole("option", { name: SECRET_NAME }));

    const preview = screen.getByTestId("auth-header-request-preview");
    expect(preview).toHaveTextContent("curl");
    expect(preview).toHaveTextContent("-H 'Authorization: Bearer ...xRZ'");

    // Selecting a credential appends it to the scheme-only default and renders it
    // as a chip, while the stored template keeps the canonical placeholder.
    expect(screen.getByLabelText(/header value template/i)).toHaveTextContent(
      "Bearer $DOCS_SITE_TOKEN",
    );
  });

  it("sends a static header with no credential attached", async () => {
    const { user, onSave } = await renderWebForm();
    await user.click(screen.getByRole("button", { name: /add header/i }));

    const headerName = screen.getByLabelText("Header name");
    await user.clear(headerName);
    await user.type(headerName, "X-Environment");
    await setTemplateText("staging");

    expect(screen.getByTestId("auth-header-request-preview")).toHaveTextContent(
      "-H 'X-Environment: staging'",
    );

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /create source/i }));
    });

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = onSave.mock.calls[0][0] as { settings: { auth_headers: unknown } };
    expect(payload.settings.auth_headers).toEqual([
      { header_name: "X-Environment", value_template: "staging" },
    ]);
  });

  it("states the ingestor's standing credential access up front", async () => {
    const { user, onSave } = await renderWebForm();

    // Always visible, so the access implication is stated before a credential
    // is ever attached rather than appearing after the fact.
    expect(
      screen.getByText(/the ingestion service reads it on each crawl/i),
    ).toBeInTheDocument();

    await addHeaderWithCredential(user);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /create source/i }));
    });

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = onSave.mock.calls[0][0] as { settings: Record<string, unknown> };
    expect(payload.settings).not.toHaveProperty("allow_unattended_credential_use");
  });

  it("omits a header whose template has no placeholder to substitute", async () => {
    const { user, onSave } = await renderWebForm();
    await addHeaderWithCredential(user);

    // Deleting the credential chip leaves a template with nothing to substitute.
    await setTemplateText("Bearer ");
    expect(screen.getByText(/type \$ to put the credential back/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /test headers/i })).toBeDisabled();

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /create source/i }));
    });

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = onSave.mock.calls[0][0] as { settings: { auth_headers: unknown[] } };
    expect(payload.settings.auth_headers).toEqual([]);
  });

  it("tests one page through the existing preview endpoint", async () => {
    const { user } = await renderWebForm();
    await addHeaderWithCredential(user);
    await user.click(screen.getByRole("button", { name: /test headers/i }));

    expect(await screen.findByText(/Fetched 1 page and found content/i)).toBeInTheDocument();
    const body = previewBody() as { settings: Record<string, unknown> };
    // Bounded by crawl mode, not by a page limit of 1, which would end the crawl
    // on its first response and report that as the reason it stopped.
    expect(body.settings.crawl_mode).toBe("single");
    expect(body.settings.max_pages).toBe(2);
    expect(body.settings.auth_headers).toEqual([
      {
        header_name: "Authorization",
        value_template: "Bearer {{secret}}",
        secret_ref: SECRET_ID,
      },
    ]);
  });

  it("explains that a bad credential often returns 404 or a sign-in page", async () => {
    // A page that fetched but yielded nothing is the ambiguous case the hint is for.
    mockFetch({ ok: true, body: { items: [] } });
    const { user } = await renderWebForm();
    await addHeaderWithCredential(user);
    await user.click(screen.getByRole("button", { name: /test headers/i }));

    expect(await screen.findByText(/no page content was returned/i)).toBeInTheDocument();
    expect(
      screen.getByText(/returns a 404 or a sign-in page instead of a 401/i),
    ).toBeInTheDocument();
  });

  it("does not blame the credential when the server reported a specific reason", async () => {
    // A configuration fault would otherwise be dressed up as a credential problem
    // and send the reader looking in the wrong place.
    mockFetch({
      ok: false,
      body: { detail: "CREDENTIAL_API_URL must be configured" },
    });
    const { user } = await renderWebForm();
    await addHeaderWithCredential(user);
    await user.click(screen.getByRole("button", { name: /test headers/i }));

    expect(await screen.findByText(/CREDENTIAL_API_URL must be configured/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/returns a 404 or a sign-in page instead of a 401/i),
    ).not.toBeInTheDocument();
  });

  it("reports a repeated header name inline and blocks save until it is resolved", async () => {
    const { user } = await renderWebForm();
    const duplicateMessage = /another header above already uses this name/i;
    const createButton = screen.getByRole("button", { name: /create source/i });

    await addHeaderWithCredential(user);
    await user.click(screen.getByRole("button", { name: /add header/i }));
    // A later row starts unnamed, so no conflict is manufactured.
    expect(screen.getAllByLabelText("Header name")[1]).toHaveValue("");
    expect(screen.queryByText(duplicateMessage)).not.toBeInTheDocument();
    expect(createButton).not.toBeDisabled();

    await user.type(screen.getAllByLabelText("Header name")[1], "Authorization");
    expect(screen.getByText(duplicateMessage)).toBeInTheDocument();
    expect(screen.getAllByLabelText("Header name")[1]).toHaveAttribute("aria-invalid", "true");
    expect(createButton).toBeDisabled();
    expect(screen.getByRole("button", { name: /test headers/i })).toBeDisabled();

    await user.clear(screen.getAllByLabelText("Header name")[1]);
    await user.type(screen.getAllByLabelText("Header name")[1], "X-Other-Token");
    expect(screen.queryByText(duplicateMessage)).not.toBeInTheDocument();
    expect(createButton).not.toBeDisabled();
  });

  it("treats header names that differ only in case as the same header", async () => {
    const { user } = await renderWebForm();
    await addHeaderWithCredential(user);
    await user.click(screen.getByRole("button", { name: /add header/i }));

    await user.type(screen.getAllByLabelText("Header name")[1], "authorization");

    expect(screen.getByText(/another header above already uses this name/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create source/i })).toBeDisabled();
  });

  it("names the first header row and leaves later rows for the user to fill", async () => {
    const { user } = await renderWebForm();

    await user.click(screen.getByRole("button", { name: /add header/i }));
    expect(screen.getAllByLabelText("Header name")[0]).toHaveValue("Authorization");

    await user.click(screen.getByRole("button", { name: /add header/i }));
    await user.click(screen.getByRole("button", { name: /add header/i }));
    const names = screen.getAllByLabelText("Header name");
    expect(names).toHaveLength(3);
    expect(names[1]).toHaveValue("");
    expect(names[2]).toHaveValue("");
    expect(screen.queryByText(/already uses this name/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create source/i })).not.toBeDisabled();
  });

  it("submits every completed row when several headers are added", async () => {
    const { user, onSave } = await renderWebForm();
    await addHeaderWithCredential(user);

    await user.click(screen.getByRole("button", { name: /add header/i }));
    await user.type(screen.getAllByLabelText("Header name")[1], "X-Second-Token");
    await user.click(screen.getAllByRole("combobox", { name: /^credential$/i })[1]);
    await user.click(await screen.findByRole("option", { name: SECRET_NAME }));

    await user.click(screen.getByRole("button", { name: /add header/i }));
    await user.type(screen.getAllByLabelText("Header name")[2], "X-Third-Token");
    await user.click(screen.getAllByRole("combobox", { name: /^credential$/i })[2]);
    await user.click(await screen.findByRole("option", { name: SECRET_NAME }));

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /create source/i }));
    });

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = onSave.mock.calls[0][0] as { settings: { auth_headers: unknown[] } };
    expect(payload.settings.auth_headers).toEqual([
      { header_name: "Authorization", value_template: "Bearer {{secret}}", secret_ref: SECRET_ID },
      { header_name: "X-Second-Token", value_template: "Bearer {{secret}}", secret_ref: SECRET_ID },
      { header_name: "X-Third-Token", value_template: "Bearer {{secret}}", secret_ref: SECRET_ID },
    ]);
  });

  it("shows only the last three characters of a credential preview", async () => {
    const { user } = await renderWebForm();
    await addHeaderWithCredential(user);

    expect(screen.getByTestId("auth-header-request-preview")).toHaveTextContent("...xRZ");
    expect(screen.queryByText(/oyw9/)).not.toBeInTheDocument();
  });

  it("labels the header columns", async () => {
    const { user } = await renderWebForm();
    await user.click(screen.getByRole("button", { name: /add header/i }));

    expect(screen.getByText("Header name")).toBeInTheDocument();
    expect(screen.getByText("Value")).toBeInTheDocument();
    expect(screen.getByText("Credential")).toBeInTheDocument();
  });

  it("stops adding rows at the header limit", async () => {
    const { user } = await renderWebForm();
    const addButton = screen.getByRole("button", { name: /add header/i });

    for (let added = 0; added < 10; added += 1) {
      expect(addButton).not.toBeDisabled();
      await user.click(addButton);
    }

    expect(screen.getAllByLabelText("Header name")).toHaveLength(10);
    expect(addButton).toBeDisabled();
    expect(screen.getByText(/maximum of 10 headers reached/i)).toBeInTheDocument();
  });

  it("hides the control when credential features are disabled", async () => {
    mockCredentialsEnabled = false;
    await renderWebForm();

    expect(screen.queryByRole("button", { name: /add header/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /^credential$/i })).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/credentials/secrets"),
    );
  });
});
