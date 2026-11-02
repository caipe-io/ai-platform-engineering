/**
 * Unit tests for ReportProblemDialog component
 *
 * Tests:
 * - Renders dialog with title and description input
 * - Submit button disabled when description is empty (no feedbackContext)
 * - Submit button enabled when feedbackContext is provided (even without description)
 * - Calls createTicketViaAgent on submit
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

let mockTicketProvider: string | null = "jira";
jest.mock("@/lib/config", () => ({
  getConfig: (key: string) => {
    switch (key) {
      case "ticketProvider":
        return mockTicketProvider;
      case "jiraTicketProject":
        return "OPENSD";
      case "githubTicketRepo":
        return "org/repo";
      default:
        return null;
    }
  },
}));

const mockCreateTicketViaAgent = jest.fn();
const mockFetchFeedbackOptions = jest.fn();
const mockFetchFeedbackComponents = jest.fn();

jest.mock("@/lib/ticket-client", () => ({
  createTicketViaAgent: (opts: unknown) => mockCreateTicketViaAgent(opts),
  fetchFeedbackOptions: (...args: unknown[]) => mockFetchFeedbackOptions(...args),
  fetchFeedbackComponents: (...args: unknown[]) => mockFetchFeedbackComponents(...args),
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
  usePathname: () => "/chat/test-uuid",
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

beforeEach(() => {
  mockFetchFeedbackComponents.mockReset().mockResolvedValue({ appId: null, components: [{ appId: null, label: "Platform" }] });
});

async function fillRequiredFields() {
  await waitFor(() => expect(screen.getByLabelText("Feature")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Short title *"), { target: { value: "The page fails to load" } });
  fireEvent.change(screen.getByLabelText("Steps to reproduce *"), { target: { value: "Open the page" } });
}

describe("ReportProblemDialog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTicketProvider = "jira";
    mockFetchFeedbackOptions.mockReset().mockResolvedValue({ appId: null, label: "Platform", features: ["Other", "Chat"] });
  });

  it("renders dialog with title when open", () => {
    render(
      <ReportProblemDialog open={true} onOpenChange={jest.fn()} />
    );
    expect(screen.getByTestId("dialog-title")).toHaveTextContent(
      "Provide Feedback"
    );
  });

  it("renders the report steps textarea", () => {
    render(
      <ReportProblemDialog open={true} onOpenChange={jest.fn()} />
    );
    expect(
      screen.getByLabelText("Steps to reproduce *")
    ).toBeInTheDocument();
  });

  it("submit button is disabled when description is empty and no feedbackContext", () => {
    render(
      <ReportProblemDialog open={true} onOpenChange={jest.fn()} />
    );
    const submitBtn = screen.getByText("Submit Report");
    expect(submitBtn).toBeDisabled();
  });

  it("requires report fields even when feedbackContext is provided", () => {
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
    const submitBtn = screen.getByText("Submit Report");
    expect(submitBtn).toBeDisabled();
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

  it("calls createTicketViaAgent on submit", async () => {
    mockCreateTicketViaAgent.mockResolvedValue({
      id: "OPENSD-123",
      url: "https://jira.example.com/browse/OPENSD-123",
      provider: "jira",
    });

    render(
      <ReportProblemDialog open={true} onOpenChange={jest.fn()} />
    );

    const textarea = screen.getByLabelText("Steps to reproduce *");
    fireEvent.change(textarea, { target: { value: "Something broke" } });

    await fillRequiredFields();
    const submitBtn = screen.getByText("Submit Report");
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockCreateTicketViaAgent).toHaveBeenCalledTimes(1);
    });
  });

  it("shows success state with ticket result", async () => {
    mockCreateTicketViaAgent.mockResolvedValue({
      id: "OPENSD-456",
      url: "https://jira.example.com/browse/OPENSD-456",
      provider: "jira",
    });

    render(
      <ReportProblemDialog open={true} onOpenChange={jest.fn()} />
    );

    fireEvent.change(
      screen.getByLabelText("Steps to reproduce *"),
      { target: { value: "Something broke" } }
    );
    await fillRequiredFields();
    fireEvent.click(screen.getByText("Submit Report"));

    await waitFor(() => {
      expect(screen.getByText("OPENSD-456")).toBeInTheDocument();
    });
  });

  it("shows error state on failure", async () => {
    mockCreateTicketViaAgent.mockRejectedValue(
      new Error("Agent unavailable")
    );

    render(
      <ReportProblemDialog open={true} onOpenChange={jest.fn()} />
    );

    fireEvent.change(
      screen.getByLabelText("Steps to reproduce *"),
      { target: { value: "Bug report" } }
    );
    await fillRequiredFields();
    fireEvent.click(screen.getByText("Submit Report"));

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

  it("keeps the dialog title neutral when a global provider is configured", () => {
    mockTicketProvider = "github";
    render(
      <ReportProblemDialog open={true} onOpenChange={jest.fn()} />
    );
    expect(screen.getByTestId("dialog-title")).toHaveTextContent(
      "Provide Feedback"
    );
  });
});

it("shows the owning app's configured features and scope", async () => {
  mockFetchFeedbackComponents.mockResolvedValue({ appId: "example", components: [{ appId: null, label: "Platform" }, { appId: "example", label: "Example app" }] });
  mockFetchFeedbackOptions.mockResolvedValue({ appId: "example", label: "Example app", features: ["Routing", "Publishing"] });
  render(<ReportProblemDialog open onOpenChange={jest.fn()} conversationId="test-conversation" />);
  await waitFor(() => expect(screen.getByLabelText("Feature")).toHaveValue("Routing"));
  expect(screen.getByLabelText("Component *")).toHaveValue("app:example");
  expect(screen.queryByRole("button", { name: "Edit component" })).not.toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Chat" })).not.toBeInTheDocument();
  expect(mockFetchFeedbackOptions).toHaveBeenCalledWith(window.location.href, "test-conversation", expect.any(AbortSignal), "example");
});
it("blocks reports while categories fail to load and supports retry", async () => {
  mockFetchFeedbackOptions.mockRejectedValueOnce(new Error("Categories unavailable"))
    .mockResolvedValue({ appId: null, label: "Platform", features: ["Other", "Chat"] });
  render(<ReportProblemDialog open onOpenChange={jest.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Categories unavailable");
  expect(screen.getByRole("button", { name: "Submit Report" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry categories" }));
  await waitFor(() => expect(screen.getByLabelText("Feature")).toBeEnabled());
});

it("changes features and submission destination together while retaining the report", async () => {
  mockFetchFeedbackComponents.mockResolvedValue({ appId: null, components: [{ appId: null, label: "Platform" }, { appId: "example", label: "Example app" }] });
  let finish!: (value: unknown) => void;
  mockFetchFeedbackOptions.mockImplementation((_url, _conversation, _signal, component) => component === "example"
    ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve({ appId: null, label: "Platform", features: ["Chat", "Other"] }));
  mockCreateTicketViaAgent.mockResolvedValue({ id: "42", provider: "github", url: "" });
  render(<ReportProblemDialog open onOpenChange={jest.fn()} />);
  await fillRequiredFields();
  fireEvent.change(screen.getByLabelText("Feature"), { target: { value: "Chat" } });
  fireEvent.change(screen.getByLabelText("Component *"), { target: { value: "app:example" } });
  expect(screen.getByRole("button", { name: "Submit Report" })).toBeDisabled();
  expect(screen.getByLabelText("Feature")).toBeDisabled();
  finish({ appId: "example", label: "Example app", features: ["Publishing", "Other"] });
  await waitFor(() => expect(screen.getByLabelText("Feature")).toBeEnabled());
  expect(screen.getByLabelText("Short title *")).toHaveValue("The page fails to load");
  expect(screen.getByLabelText("Feature")).toHaveValue("Other");
  expect(screen.queryByRole("option", { name: "Chat" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Feature"), { target: { value: "Publishing" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit Report" }));
  await waitFor(() => expect(mockCreateTicketViaAgent).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ componentId: "example", feature: "Publishing" }) })));
});

it("does not offer screenshot capture when the selected handler cannot attach images", async () => {
  mockFetchFeedbackOptions.mockResolvedValue({ appId: null, label: "Platform", features: ["Other"], screenshotsEnabled: false });
  render(<ReportProblemDialog open onOpenChange={jest.fn()} />);
  await waitFor(() => expect(screen.getByLabelText("Feature")).toBeEnabled());
  expect(screen.queryByRole("button", { name: "Auto-capture screen" })).not.toBeInTheDocument();
  expect(screen.queryByText("Upload image")).not.toBeInTheDocument();
});


it("preselects the calling component and its feature through the authorized registry", async () => {
  mockFetchFeedbackComponents.mockResolvedValue({ appId: "example", components: [{ appId: null, label: "Platform" }, { appId: "example", label: "Example app" }] });
  mockFetchFeedbackOptions.mockResolvedValue({ appId: "example", label: "Example app", features: ["Other", "Publishing"] });
  render(<ReportProblemDialog open onOpenChange={jest.fn()} initialComponentId="example" initialFeature="Publishing" />);
  await waitFor(() => expect(screen.getByLabelText("Feature")).toHaveValue("Publishing"));
  expect(screen.getByLabelText("Component *")).toHaveValue("app:example");
  expect(screen.queryByRole("button", { name: "Edit component" })).not.toBeInTheDocument();
  expect(mockFetchFeedbackComponents).toHaveBeenCalledWith(window.location.href, undefined, expect.any(AbortSignal), "example");
});


it("submits optional impact from the expanded details section", async () => {
  mockFetchFeedbackOptions.mockResolvedValue({ appId: null, label: "Platform", features: ["Other"] });
  mockCreateTicketViaAgent.mockResolvedValue({ id: "42", provider: "github", url: "https://example.test/issues/42" });
  render(<ReportProblemDialog open onOpenChange={jest.fn()} />);
  await fillRequiredFields();
  expect(screen.getByText("How much does it affect you?").closest("details")).toHaveAttribute("open");
  for (const label of ["Blocks my work", "Annoying", "Minor"]) expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(screen.getByRole("button", { name: "Annoying" }));
  fireEvent.click(screen.getByRole("button", { name: "Submit Report" }));
  await waitFor(() => expect(mockCreateTicketViaAgent).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ severity: "Annoying", description: expect.stringContaining("Impact: Annoying") }) })));
});
