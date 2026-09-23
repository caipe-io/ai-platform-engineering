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
            maskedPreview: "d...n",
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
    expect(JSON.stringify(payload)).not.toContain("d...n");
  });

  it("keeps a custom header name and a custom value prefix", async () => {
    const { user, onSave } = await renderWebForm();
    await addHeaderWithCredential(user);

    await user.selectOptions(screen.getByLabelText(/header name/i), "__custom__");
    await user.type(screen.getByLabelText(/custom header name/i), "X-Docs-Token");
    const template = screen.getByLabelText(/header value template/i);
    await user.clear(template);
    // `type` reads `{{` as an escaped brace, so paste the placeholder verbatim.
    await user.click(template);
    await user.paste("Token {{secret}}");

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

  it("renders the placeholder as a credential token once a credential is selected", async () => {
    const { user } = await renderWebForm();
    await user.click(screen.getByRole("button", { name: /add header/i }));

    expect(screen.getByTestId("auth-header-preview-0")).toHaveTextContent("Bearer {{secret}}");

    await user.click(await screen.findByRole("combobox", { name: /^credential$/i }));
    await user.click(await screen.findByRole("option", { name: SECRET_NAME }));

    expect(screen.getByTestId("auth-header-preview-0")).toHaveTextContent(
      "Bearer $DOCS_SITE_TOKEN",
    );
    expect(screen.getByLabelText(/header value template/i)).toHaveValue("Bearer {{secret}}");
  });

  it("explains the ingestor's standing credential access once a header resolves", async () => {
    const { user, onSave } = await renderWebForm();
    const noticeHeading = /credential access for this source/i;
    expect(screen.queryByText(noticeHeading)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /add header/i }));
    expect(screen.queryByText(noticeHeading)).not.toBeInTheDocument();

    await user.click(await screen.findByRole("combobox", { name: /^credential$/i }));
    await user.click(await screen.findByRole("option", { name: SECRET_NAME }));
    expect(screen.getByText(noticeHeading)).toBeInTheDocument();
    expect(screen.getByText(/on every crawl of this source, including scheduled refreshes/i))
      .toBeInTheDocument();

    // A reload interval is irrelevant: the ingestor authenticates as itself for
    // every crawl, so the notice is not tied to scheduling.
    const reloadInterval = screen.getByLabelText(/reload interval/i);
    await user.clear(reloadInterval);
    await user.type(reloadInterval, "0");
    expect(screen.getByText(noticeHeading)).toBeInTheDocument();

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

    const template = screen.getByLabelText(/header value template/i);
    await user.clear(template);
    await user.type(template, "Bearer ");
    expect(screen.getByText(/add \{\{secret\}\} where the credential value belongs/i))
      .toBeInTheDocument();
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
    expect(body.settings.max_pages).toBe(1);
    expect(body.settings.auth_headers).toEqual([
      {
        header_name: "Authorization",
        value_template: "Bearer {{secret}}",
        secret_ref: SECRET_ID,
      },
    ]);
  });

  it("explains that a bad credential often returns 404 or a sign-in page", async () => {
    mockFetch({ ok: false, body: { detail: "Crawl returned no documents" } });
    const { user } = await renderWebForm();
    await addHeaderWithCredential(user);
    await user.click(screen.getByRole("button", { name: /test headers/i }));

    expect(await screen.findByText(/Crawl returned no documents/i)).toBeInTheDocument();
    expect(
      screen.getByText(/returns a 404 or a sign-in page instead of a 401/i),
    ).toBeInTheDocument();
  });

  it("reports a repeated header name inline and blocks save until it is resolved", async () => {
    const { user } = await renderWebForm();
    const duplicateMessage = /another header above already uses this name/i;
    const createButton = screen.getByRole("button", { name: /create source/i });

    await addHeaderWithCredential(user);
    await user.click(screen.getByRole("button", { name: /add header/i }));
    // A new row takes the first unused name, so no conflict is manufactured.
    expect(screen.queryByText(duplicateMessage)).not.toBeInTheDocument();
    expect(createButton).not.toBeDisabled();

    await user.selectOptions(screen.getAllByLabelText("Header name")[1], "Authorization");
    expect(screen.getByText(duplicateMessage)).toBeInTheDocument();
    expect(screen.getAllByLabelText("Header name")[1]).toHaveAttribute("aria-invalid", "true");
    expect(createButton).toBeDisabled();
    expect(screen.getByRole("button", { name: /test headers/i })).toBeDisabled();

    await user.selectOptions(screen.getAllByLabelText("Header name")[1], "Cookie");
    expect(screen.queryByText(duplicateMessage)).not.toBeInTheDocument();
    expect(createButton).not.toBeDisabled();
  });

  it("treats header names that differ only in case as the same header", async () => {
    const { user } = await renderWebForm();
    await addHeaderWithCredential(user);
    await user.click(screen.getByRole("button", { name: /add header/i }));

    await user.selectOptions(screen.getAllByLabelText("Header name")[1], "__custom__");
    await user.type(screen.getByLabelText(/custom header name/i), "authorization");

    expect(screen.getByText(/another header above already uses this name/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create source/i })).toBeDisabled();
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
