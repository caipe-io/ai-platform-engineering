/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockToast = jest.fn();
const mockRouterReplace = jest.fn();
let mockRequestId: string | null = null;
let mockView: string | null = "history";

jest.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

jest.mock("next/navigation", () => ({
  usePathname: () => "/admin/security",
  useRouter: () => ({ replace: mockRouterReplace }),
  useSearchParams: () => ({
    get: (key: string) => key === "view"
      ? mockView
      : key === "request"
        ? mockRequestId
        : null,
    toString: () => {
      const params = new URLSearchParams();
      if (mockView) params.set("view", mockView);
      if (mockRequestId) params.set("request", mockRequestId);
      return params.toString();
    },
  }),
}));

import { PublicationApprovalQueue } from "../PublicationApprovalQueue";

describe("PublicationApprovalQueue", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequestId = null;
    mockView = "history";
  });

  it("does not requester-scope an administrator's deep-linked History", async () => {
    mockRequestId = "request-primary";
    const requestedUrls: string[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === "/api/publication-requests/summary") {
        return {
          ok: true,
          json: async () => ({
            pending_count: 0,
            requester_pending_count: 0,
            can_approve: true,
            can_manage_settings: true,
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          requests: [],
          pagination: { page: 1, page_size: 20, total: 0, total_pages: 1 },
        }),
      } as Response;
    });

    render(<PublicationApprovalQueue />);

    await waitFor(() => expect(requestedUrls.some((url) =>
      url.includes("request_id=request-primary") && !url.includes("mine=true")
    )).toBe(true));
  });

  it("shows who approved a publication in History", async () => {
    const approvedRequest = {
      _id: "request-primary",
      adapter_version: 1 as const,
      resource: {
        kind: "rag_datasource" as const,
        id: "source-primary",
        label: "Primary handbook",
      },
      authorization_policy_id: "publication/request-primary",
      resource_revision: "revision-primary",
      requested_state: {
        search_team_slugs: [],
        search_user_subjects: [],
      },
      effective_state: {
        search_team_slugs: ["everyone"],
        search_user_subjects: [],
      },
      risk_facts: {
        organization_wide: true,
        target_team_slugs: ["everyone"],
        removed_team_slugs: ["everyone"],
        reasons: ["organization-wide audience removal"],
      },
      requester: {
        subject: "requester-subject",
        name: "Requesting User",
      },
      requester_team_slugs: [],
      approver_team_slugs: [],
      approver_user_subjects: [],
      status: "approved" as const,
      history: [{
        action: "approved" as const,
        at: "2026-01-02T00:00:00.000Z",
        actor: {
          subject: "reviewer-subject",
          name: "Review Admin",
        },
      }],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      decided_at: "2026-01-02T00:00:00.000Z",
      decided_by: {
        subject: "reviewer-subject",
        name: "Review Admin",
      },
    };
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/publication-requests/summary") {
        return {
          ok: true,
          json: async () => ({
            pending_count: 0,
            requester_pending_count: 0,
            can_approve: true,
            can_manage_settings: true,
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          requests: [approvedRequest],
          pagination: { page: 1, page_size: 20, total: 1, total_pages: 1 },
        }),
      } as Response;
    });

    render(<PublicationApprovalQueue />);

    expect(await screen.findByText("Approved by Review Admin")).toBeInTheDocument();
    expect(screen.getByText("Remove Search for: Everyone")).toBeInTheDocument();
    expect(screen.getByText("approved")).toHaveClass("text-emerald-600");
  });

  it("scopes an ordinary user's paginated History to their own requests", async () => {
    const requestedUrls: string[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === "/api/publication-requests/summary") {
        return {
          ok: true,
          json: async () => ({
            pending_count: 0,
            requester_pending_count: 0,
            can_approve: false,
            can_manage_settings: false,
          }),
        } as Response;
      }
      const page = new URL(url, "http://localhost").searchParams.get("page");
      return {
        ok: true,
        json: async () => ({
          requests: [{
            _id: `request-${page}`,
            adapter_version: 1,
            resource: {
              kind: "slack_channel",
              id: "channel-primary",
              label: "Slack: #primary",
            },
            authorization_policy_id: `publication/request-${page}`,
            resource_revision: "revision-primary",
            requested_state: { team_slug: "team-primary", agent_id: "agent-primary" },
            effective_state: {},
            risk_facts: {
              organization_wide: false,
              target_team_slugs: ["team-primary"],
              reasons: [],
            },
            requester: { subject: "user-primary", name: "Example User" },
            requester_team_slugs: ["team-primary"],
            approver_team_slugs: ["reviewers"],
            status: "rejected",
            decision_note: "Choose a team that owns this channel.",
            history: [],
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-02T00:00:00.000Z",
          }],
          pagination: {
            page: Number(page),
            page_size: 20,
            total: 21,
            total_pages: 2,
          },
        }),
      } as Response;
    });

    render(<PublicationApprovalQueue />);

    await waitFor(() => expect(requestedUrls.some((url) =>
      url.includes("/api/publication-requests?") && url.includes("mine=true")
    )).toBe(true));
    expect(await screen.findByText(
      "Reason: Choose a team that owns this channel.",
    )).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() => expect(requestedUrls.some((url) => url.includes("page=2"))).toBe(true));
  });

  it("clears the linked request query param after approving it", async () => {
    mockView = "pending";
    mockRequestId = "request-linked";
    const pendingRequest = {
      _id: "request-linked",
      adapter_version: 1 as const,
      resource: {
        kind: "slack_channel" as const,
        id: "channel-primary",
        label: "Slack: #primary",
      },
      authorization_policy_id: "publication/request-linked",
      resource_revision: "revision-primary",
      requested_state: { team_slug: "team-primary", agent_id: "agent-primary" },
      effective_state: {},
      risk_facts: {
        organization_wide: false,
        target_team_slugs: ["team-primary"],
        reasons: [],
      },
      requester: { subject: "user-primary", name: "Example User" },
      requester_team_slugs: ["team-primary"],
      approver_team_slugs: ["reviewers"],
      approver_user_subjects: [],
      status: "pending" as const,
      history: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };

    const requestedUrls: string[] = [];
    let listCallCount = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === "/api/publication-requests/summary") {
        return {
          ok: true,
          json: async () => ({
            pending_count: 1,
            requester_pending_count: 0,
            can_approve: true,
            can_manage_settings: true,
          }),
        } as Response;
      }
      if (url === "/api/publication-requests/request-linked/approve") {
        return { ok: true, json: async () => ({}) } as Response;
      }
      if (url.startsWith("/api/publication-requests?")) {
        listCallCount += 1;
        const requests = listCallCount === 1 ? [pendingRequest] : [];
        return {
          ok: true,
          json: async () => ({
            requests,
            pagination: { page: 1, page_size: 20, total: requests.length, total_pages: 1 },
          }),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<PublicationApprovalQueue />);

    expect(await screen.findByText("Slack: #primary")).toBeInTheDocument();
    await waitFor(() => expect(requestedUrls.some((url) =>
      url.includes("/api/publication-requests?") && url.includes("request_id=request-linked"),
    )).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: /Approve & publish/i }));

    await waitFor(() => expect(requestedUrls).toContain(
      "/api/publication-requests/request-linked/approve",
    ));

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalled());
    const replacedUrl = mockRouterReplace.mock.calls.at(-1)?.[0] as string;
    expect(replacedUrl).not.toContain("request=");

    await waitFor(() => expect(listCallCount).toBeGreaterThanOrEqual(2));
    const listUrls = requestedUrls.filter((url) => url.startsWith("/api/publication-requests?"));
    expect(listUrls.at(-1)).not.toContain("request_id=");
  });
});
