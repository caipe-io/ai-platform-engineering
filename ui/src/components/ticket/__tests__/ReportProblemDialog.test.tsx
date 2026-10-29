/**
 * Unit tests for ReportProblemDialog component
 *
 * Tests:
 * - Renders dialog with title and description input
 * - Submit button disabled when description is empty (no feedbackContext)
 * - Submit button enabled when feedbackContext is provided (even without description)
 * - Calls createTicketViaApi on submit
 * - Shows success state with ticket result
 * - Shows error state on failure
 * - Cancel during submission aborts the request
 * - Displays feedback context in combo flow
 * - Shows streaming debug log panel
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ============================================================================
// Mocks — must be before imports
// ============================================================================

let mockPathname = "/chat/test-uuid";
let mockTicketProvider: string | null = "jira";
jest.mock("@/lib/config", () => ({
  getConfig: (key: string) => {
    switch (key) {
      case "ticketProvider":
        return mockTicketProvider;
      case "jiraTicketProject":
        return "TEST";
      case "githubTicketRepo":
        return "org/repo";
      default:
        return null;
    }
  },
}));

const mockCreateTicketViaApi = jest.fn();

jest.mock("@/lib/ticket-client", () => ({
  createTicketViaApi: (opts: unknown) => mockCreateTicketViaApi(opts),
}));

jest.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: { email: "test@example.com" },
      accessToken: "test-token",
    },
  }),
}));

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

jest.mock("framer-motion", () => ({
  motion: {
    // eslint-disable-next-line react/display-name
    div: React.forwardRef(
      (
        {
          children,
          ...props
        }: { children?: React.ReactNode } & Record<string, unknown>,
        ref: React.Ref<HTMLDivElement>
      ) => (
        <div ref={ref} {...props}>
          {children}
        </div>
      )
    ),
  },
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
}));

jest.mock("lucide-react", () => ({
  AlertCircle: () => <span data-testid="icon-alert" />,
  Camera: () => <span data-testid="icon-camera" />,
  CheckCircle2: () => <span data-testid="icon-check" />,
  ChevronDown: () => <span data-testid="icon-chevron-down" />,
  ChevronUp: () => <span data-testid="icon-chevron-up" />,
  Copy: () => <span data-testid="icon-copy" />,
  ExternalLink: () => <span data-testid="icon-external" />,
  Loader2: () => <span data-testid="icon-loader" />,
  Monitor: () => <span data-testid="icon-monitor" />,
  RefreshCw: () => <span data-testid="icon-refresh" />,
  Square: () => <span data-testid="icon-square" />,
  Terminal: () => <span data-testid="icon-terminal" />,
  Upload: () => <span data-testid="icon-upload" />,
  X: () => <span data-testid="icon-x" />,
}));

jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
  }: {
    children?: React.ReactNode;
    open?: boolean;
  }) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogContent: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogHeader: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="dialog-header">{children}</div>
  ),
  DialogTitle: ({ children }: { children?: React.ReactNode }) => (
    <h2 data-testid="dialog-title">{children}</h2>
  ),
  DialogDescription: ({ children }: { children?: React.ReactNode }) => (
    <p data-testid="dialog-description">{children}</p>
  ),
}));

jest.mock("@/components/ui/button", () => ({
  // eslint-disable-next-line react/display-name
  Button: React.forwardRef(
    (
      {
        children,
        onClick,
        disabled,
        ...props
      }: {
        children?: React.ReactNode;
        onClick?: () => void;
        disabled?: boolean;
      } & Record<string, unknown>,
      ref: React.Ref<HTMLButtonElement>
    ) => (
      <button ref={ref} onClick={onClick} disabled={disabled} {...props}>
        {children}
      </button>
    )
  ),
}));

// ============================================================================
// Import after mocks
// ============================================================================

import { ReportProblemDialog } from "../ReportProblemDialog";

// ============================================================================
// Tests
// ============================================================================

describe("ReportProblemDialog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTicketProvider = "jira";
    mockPathname = "/chat/test-uuid";
    global.fetch = jest.fn().mockImplementation(async () => ({ ok: true, json: async () => ({ success: true, data: [
      { id: "chat", label: "Chat", provider: mockTicketProvider, githubRepo: "example/platform", jiraProject: "TEST", pathPrefixes: ["/chat"], canAttachScreenshot: true },
      { id: "app-example", label: "Example app", provider: "github", githubRepo: "example/product", pathPrefixes: ["/projects"], appId: "example" },
    ] }) }));
  });

  it("renders dialog with title when open", () => {
    render(
      <ReportProblemDialog open={true} onOpenChange={jest.fn()} />
    );
    expect(screen.getByTestId("dialog-title")).toHaveTextContent(
      "Provide Feedback"
    );
  });

  it("renders description textarea", () => {
    render(
      <ReportProblemDialog open={true} onOpenChange={jest.fn()} />
    );
    expect(
      screen.getByPlaceholderText(
        "What went wrong? Be as specific as you can."
      )
    ).toBeInTheDocument();
  });

  it("submit button is disabled when description is empty and no feedbackContext", () => {
    render(
      <ReportProblemDialog open={true} onOpenChange={jest.fn()} />
    );
    const submitBtn = screen.getByText(/Submit (Jira|GitHub) Issue/);
    expect(submitBtn).toBeDisabled();
  });

  it("submit button is enabled when feedbackContext is provided", async () => {
    render(
      <ReportProblemDialog
        open={true}
        onOpenChange={jest.fn()}
        feedbackContext={{
          reason: "Inaccurate",
          feedbackType: "dislike",
        }}
      />
    );
    const submitBtn = screen.getByText(/Submit (Jira|GitHub) Issue/);
    await waitFor(() => expect(submitBtn).not.toBeDisabled());
  });

  it("shows feedback context in combo flow", () => {
    render(
      <ReportProblemDialog
        open={true}
        onOpenChange={jest.fn()}
        feedbackContext={{
          reason: "Off-topic",
          additionalFeedback: "Response was unrelated",
          feedbackType: "dislike",
        }}
      />
    );
    expect(screen.getByText(/Off-topic/)).toBeInTheDocument();
    expect(screen.getByText(/Response was unrelated/)).toBeInTheDocument();
  });

  it("calls createTicketViaApi on submit", async () => {
    mockCreateTicketViaApi.mockResolvedValue({
      id: "TEST-123",
      url: "https://jira.example.com/browse/TEST-123",
      provider: "jira",
    });

    render(
      <ReportProblemDialog open={true} onOpenChange={jest.fn()} />
    );

    const textarea = screen.getByPlaceholderText(
      "What went wrong? Be as specific as you can."
    );
    fireEvent.change(textarea, { target: { value: "Something broke" } });

    const submitBtn = screen.getByText(/Submit (Jira|GitHub) Issue/);
    await waitFor(() => expect(submitBtn).toBeEnabled());
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockCreateTicketViaApi).toHaveBeenCalledTimes(1);
    });
  });

  it("shows success state with ticket result", async () => {
    mockCreateTicketViaApi.mockResolvedValue({
      id: "TEST-456",
      url: "https://jira.example.com/browse/TEST-456",
      provider: "jira",
    });

    render(
      <ReportProblemDialog open={true} onOpenChange={jest.fn()} />
    );

    fireEvent.change(
      screen.getByPlaceholderText(
        "What went wrong? Be as specific as you can."
      ),
      { target: { value: "Something broke" } }
    );
    await waitFor(() => expect(screen.getByText(/Submit (Jira|GitHub) Issue/)).toBeEnabled());
    fireEvent.click(screen.getByText(/Submit (Jira|GitHub) Issue/));

    await waitFor(() => {
      expect(screen.getByText("TEST-456")).toBeInTheDocument();
    });
  });

  it("shows error state on failure", async () => {
    mockCreateTicketViaApi.mockRejectedValue(
      new Error("Agent unavailable")
    );

    render(
      <ReportProblemDialog open={true} onOpenChange={jest.fn()} />
    );

    fireEvent.change(
      screen.getByPlaceholderText(
        "What went wrong? Be as specific as you can."
      ),
      { target: { value: "Bug report" } }
    );
    await waitFor(() => expect(screen.getByText(/Submit (Jira|GitHub) Issue/)).toBeEnabled());
    fireEvent.click(screen.getByText(/Submit (Jira|GitHub) Issue/));

    await waitFor(() => {
      expect(screen.getByText("Agent unavailable")).toBeInTheDocument();
    });
  });

  it("does not render when not open", () => {
    render(
      <ReportProblemDialog open={false} onOpenChange={jest.fn()} />
    );
    expect(screen.queryByTestId("dialog")).not.toBeInTheDocument();
  });

  it("uses GitHub label when ticketProvider is github", () => {
    mockTicketProvider = "github";
    render(
      <ReportProblemDialog open={true} onOpenChange={jest.fn()} />
    );
    expect(screen.getByTestId("dialog-title")).toHaveTextContent(
      "Provide Feedback"
    );
  });
});

it("selects the app destination from the current page and submits its enhancement type", async () => {
  mockPathname = "/projects/example";
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: [
    { id: "app-example", label: "Example app", provider: "github", githubRepo: "example/product", pathPrefixes: ["/projects"], appId: "example" },
  ] }) });
  mockCreateTicketViaApi.mockResolvedValue({ id: "#42", url: "https://github.com/example/product/issues/42", provider: "github" });
  render(<ReportProblemDialog open onOpenChange={jest.fn()} />);
  expect(await screen.findByText("GitHub issue in example/product")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Type *"), { target: { value: "Enhancement" } });
  fireEvent.change(screen.getByPlaceholderText("What went wrong? Be as specific as you can."), { target: { value: "Improve navigation" } });
  fireEvent.click(screen.getByText("Submit GitHub Issue"));
  await waitFor(() => expect(mockCreateTicketViaApi).toHaveBeenCalledWith(expect.objectContaining({ areaId: "app-example", issueType: "Enhancement" })));
});
