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
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

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
  GitBranch: () => <span data-testid="icon-branch" />,
  Loader2: () => <span data-testid="icon-loader" />,
  Monitor: () => <span data-testid="icon-monitor" />,
  Plus: () => <span data-testid="icon-plus" />,
  RefreshCw: () => <span data-testid="icon-refresh" />,
  Search: () => <span data-testid="icon-search" />,
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
    : Promise.resolve({ appId: null, label: "Platform", features: ["Chat", "Other"], destination: { provider: "github", repository: "example/platform-feedback" } }));
  mockCreateTicketViaAgent.mockResolvedValue({ id: "42", provider: "github", url: "" });
  render(<ReportProblemDialog open onOpenChange={jest.fn()} />);
  await fillRequiredFields();
  fireEvent.change(screen.getByLabelText("Feature"), { target: { value: "Chat" } });
  expect(screen.getByText("→ GitHub issue in example/platform-feedback")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Component *"), { target: { value: "app:example" } });
  expect(screen.queryByText("→ GitHub issue in example/platform-feedback")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Submit Report" })).toBeDisabled();
  expect(screen.getByLabelText("Feature")).toBeDisabled();
  finish({ appId: "example", label: "Example app", features: ["Publishing", "Other"], destination: { provider: "github", repository: "example/app-feedback" } });
  await waitFor(() => expect(screen.getByLabelText("Feature")).toBeEnabled());
  expect(screen.getByText("→ GitHub issue in example/app-feedback")).toBeInTheDocument();
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

it("shows the configured Jira project for an agent-backed destination", async () => {
  mockFetchFeedbackOptions.mockResolvedValue({ appId: null, label: "Platform", features: ["Other"],
    destination: { provider: "jira", project: "TEST" } });
  render(<ReportProblemDialog open onOpenChange={jest.fn()} />);
  expect(await screen.findByText("→ Jira issue in TEST")).toBeInTheDocument();
});

describe("Request help", () => {
  const serviceDesk = {
    repository: "example/service-desk",
    areas: ["Compute", "Vault", "GitHub", "AI / ML", "Networking / DNS / Certificates", "Other"],
    severities: ["Urgent", "High", "Medium", "Low"],
    types: ["Bug", "Enhancement", "Ticket"],
  };
  beforeEach(() => {
    mockCreateTicketViaAgent.mockReset().mockResolvedValue({ id: "#7", provider: "github", url: "https://example.test/issues/7" });
    mockFetchFeedbackOptions.mockReset().mockResolvedValue({ appId: null, label: "Platform", features: ["Other"], serviceDesk });
  });
  const openRequestHelp = async () => {
    render(<ReportProblemDialog open onOpenChange={jest.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Request help" }));
  };

  it("marks the title as required in red only in Request help mode", async () => {
    await openRequestHelp();
    const ticketLabel = screen.getByText("Ticket title", { selector: "label" });
    expect(ticketLabel.querySelector(".text-destructive")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Bug" }));
    const shortLabel = await screen.findByText("Short title *", { selector: "label" });
    expect(shortLabel.querySelector(".text-destructive")).toBeNull();
  });

  it("returns to the feedback form after switching component away and back", async () => {
    mockFetchFeedbackComponents.mockResolvedValue({ appId: null, components: [{ appId: null, label: "Platform" }, { appId: "example", label: "Example app" }] });
    mockFetchFeedbackOptions.mockImplementation((_url, _conversation, _signal, component) => component === "example"
      ? Promise.resolve({ appId: "example", label: "Example app", features: ["Other"] })
      : Promise.resolve({ appId: null, label: "Platform", features: ["Other"], serviceDesk }));
    await openRequestHelp();
    expect(screen.getByRole("button", { name: "Request help" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByLabelText("Component *"), { target: { value: "app:example" } });
    await waitFor(() => expect(screen.getByLabelText("Feature")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Component *"), { target: { value: "platform" } });
    expect(await screen.findByRole("button", { name: "Request help" })).toHaveAttribute("aria-pressed", "false");
  });

  it("trims the title to the feedback limit when leaving Request help", async () => {
    await openRequestHelp();
    fireEvent.change(screen.getByLabelText("Ticket title *"), { target: { value: "t".repeat(100) } });
    fireEvent.click(screen.getByRole("button", { name: "Bug" }));
    expect(screen.getByLabelText("Short title *")).toHaveValue("t".repeat(60));
  });

  it("offers Request help only when the platform accepts it", async () => {
    mockFetchFeedbackOptions.mockResolvedValue({ appId: null, label: "Platform", features: ["Other"] });
    render(<ReportProblemDialog open onOpenChange={jest.fn()} />);
    await waitFor(() => expect(screen.getByLabelText("Feature")).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Request help" })).not.toBeInTheDocument();
  });

  const chooseAreas = (...areas: string[]) => {
    fireEvent.click(screen.getByRole("button", { name: "Area of impact" }));
    for (const area of areas) fireEvent.click(screen.getByRole("button", { name: area }));
    fireEvent.click(screen.getByRole("button", { name: "Area of impact" }));
  };

  it("shows the agent form's fields and its destination", async () => {
    await openRequestHelp();
    expect(screen.getByText("→ GitHub issue in example/service-desk")).toBeInTheDocument();
    for (const label of ["Ticket title *", "Description *", "Area of impact", "Severity *", "Type *"]) expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.getByText("Area of impact").parentElement).toHaveTextContent("Area of impact *");
    expect(screen.queryByLabelText("Allow multiple")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Area of impact" }));
    expect(screen.getAllByRole("button", { name: "Networking / DNS / Certificates" })).toHaveLength(1);
    expect(screen.getByLabelText("Severity *")).toHaveValue("Medium");
    expect(screen.getByLabelText("Type *")).toHaveValue("Ticket");
    expect(screen.queryByLabelText("Steps to reproduce *")).not.toBeInTheDocument();
  });

  it("lays the area picker out like Severity and Type: label above, full-width control and list", async () => {
    await openRequestHelp();
    const label = screen.getByText("Area of impact");
    const trigger = screen.getByRole("button", { name: "Area of impact" });
    expect(label).toHaveClass("block");
    expect(trigger.parentElement).toHaveClass("w-full");
    fireEvent.click(trigger);
    expect(document.querySelector("[data-popover-content]")).toHaveClass("w-full");
  });

  it("requires a title, a description and an area before submitting", async () => {
    await openRequestHelp();
    const submit = screen.getByRole("button", { name: "Submit Request" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Ticket title *"), { target: { value: "Vault access" } });
    fireEvent.change(screen.getByLabelText("Description *"), { target: { value: "Admin role does not grant access." } });
    expect(submit).toBeDisabled();
    chooseAreas("Vault");
    expect(submit).toBeEnabled();
  });

  it("submits the service desk request with several areas", async () => {
    await openRequestHelp();
    fireEvent.change(screen.getByLabelText("Ticket title *"), { target: { value: "Vault access" } });
    fireEvent.change(screen.getByLabelText("Description *"), { target: { value: "Admin role does not grant access." } });
    chooseAreas("Vault", "GitHub");
    fireEvent.change(screen.getByLabelText("Severity *"), { target: { value: "High" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit Request" }));
    await waitFor(() => expect(mockCreateTicketViaAgent).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({
      requestType: "service-desk", title: "Vault access", description: "Admin role does not grant access.", componentId: null,
      serviceDesk: { areas: ["Vault", "GitHub"], severity: "High", type: "Ticket", details: [] },
    }) })));
  });

  it("copies the help request, classification and selected details after submission fails", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      mockCreateTicketViaAgent.mockRejectedValueOnce(new Error("Service unavailable"));
      await openRequestHelp();
      fireEvent.change(screen.getByLabelText("Ticket title *"), { target: { value: "Access request" } });
      fireEvent.change(screen.getByLabelText("Description *"), { target: { value: "Please grant access to the example namespace." } });
      chooseAreas("Vault");
      fireEvent.change(screen.getByLabelText("Namespace path"), { target: { value: "example/apps" } });
      fireEvent.change(screen.getByLabelText("Severity *"), { target: { value: "High" } });
      fireEvent.click(screen.getByRole("button", { name: "Submit Request" }));
      await screen.findByText("Service unavailable");
      fireEvent.click(screen.getByRole("button", { name: "Copy Description" }));
      expect(writeText).toHaveBeenCalledWith([
        "Access request", "Please grant access to the example namespace.", "Areas of impact: Vault",
        "Severity: High", "Type: Ticket", "Vault — Namespace path: example/apps",
      ].join("\n\n"));
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it.each([
    ["the chat feedback flow", { onBeforeSubmit: jest.fn() }, { serviceDesk }],
    ["a component without Request help", {}, {}],
  ])("says Request help is unavailable and hides the form in %s when feedback is off", async (_name, props, extra) => {
    const onOpenChange = jest.fn();
    mockFetchFeedbackOptions.mockResolvedValue({ appId: null, label: "Platform", features: ["Other"], feedbackEnabled: false, ...extra });
    render(<ReportProblemDialog open onOpenChange={onOpenChange} {...props} />);
    expect(await screen.findByText("Request help is unavailable for this component.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Submit/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Short title *")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Component *")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("trims the title to the feedback limit when the component switch leaves Request help", async () => {
    mockFetchFeedbackComponents.mockResolvedValue({ appId: null, components: [{ appId: null, label: "Platform" }, { appId: "example", label: "Example app" }] });
    mockFetchFeedbackOptions.mockImplementation((_url, _conversation, _signal, component) => component === "example"
      ? Promise.resolve({ appId: "example", label: "Example app", features: ["Other"] })
      : Promise.resolve({ appId: null, label: "Platform", features: ["Other"], serviceDesk }));
    await openRequestHelp();
    fireEvent.change(screen.getByLabelText("Ticket title *"), { target: { value: "t".repeat(100) } });
    fireEvent.change(screen.getByLabelText("Component *"), { target: { value: "app:example" } });
    await waitFor(() => expect(screen.getByLabelText("Feature")).toBeEnabled());
    await waitFor(() => expect(screen.getByLabelText("Short title *")).toHaveValue("t".repeat(60)));
    expect(screen.getByText("60/60")).toBeInTheDocument();
  });

  it("sends a context URL within the API limit when the page URL is too long", async () => {
    const original = window.location.href;
    try {
      window.history.pushState({}, "", `/page-a?q=${"x".repeat(2100)}#frag`);
      await openRequestHelp();
      fireEvent.change(screen.getByLabelText("Ticket title *"), { target: { value: "Need access" } });
      fireEvent.change(screen.getByLabelText("Description *"), { target: { value: "Please grant access." } });
      chooseAreas("Vault");
      fireEvent.click(screen.getByRole("button", { name: "Submit Request" }));
      await waitFor(() => expect(mockCreateTicketViaAgent).toHaveBeenCalledTimes(1));
      const { contextUrl } = mockCreateTicketViaAgent.mock.calls[0][0].request;
      expect(contextUrl.length).toBeLessThanOrEqual(2000);
      expect(new URL(contextUrl).pathname).toBe("/page-a");
    } finally {
      window.history.pushState({}, "", original);
    }
  });

  it("keeps a long Request help title while the options reload", async () => {
    const { rerender } = render(<ReportProblemDialog open onOpenChange={jest.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Request help" }));
    fireEvent.change(screen.getByLabelText("Ticket title *"), { target: { value: "t".repeat(100) } });
    mockFetchFeedbackOptions.mockClear();
    rerender(<ReportProblemDialog open onOpenChange={jest.fn()} conversationId="other-conversation" />);
    await waitFor(() => expect(mockFetchFeedbackOptions).toHaveBeenCalled());
    await screen.findByRole("button", { name: "Request help" });
    fireEvent.click(screen.getByRole("button", { name: "Request help" }));
    expect(screen.getByLabelText("Ticket title *")).toHaveValue("t".repeat(100));
  });

  it("trims a long Request help title when the reloaded options no longer offer it", async () => {
    const { rerender } = render(<ReportProblemDialog open onOpenChange={jest.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Request help" }));
    fireEvent.change(screen.getByLabelText("Ticket title *"), { target: { value: "t".repeat(100) } });
    mockFetchFeedbackOptions.mockResolvedValue({ appId: null, label: "Platform", features: ["Other"] });
    rerender(<ReportProblemDialog open onOpenChange={jest.fn()} conversationId="other-conversation" />);
    await waitFor(() => expect(screen.getByLabelText("Short title *")).toHaveValue("t".repeat(60)));
  });

  it("resets the draft when the unavailable view is closed", async () => {
    const onOpenChange = jest.fn();
    mockFetchFeedbackOptions.mockResolvedValue({ appId: null, label: "Platform", features: ["Other"], feedbackEnabled: false });
    render(<ReportProblemDialog open onOpenChange={onOpenChange} />);
    await screen.findByText("Request help is unavailable for this component.");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText("Request help is unavailable for this component.")).not.toBeInTheDocument();
  });

  it("does not show the unavailable notice while Request help can be chosen", async () => {
    mockFetchFeedbackOptions.mockResolvedValue({ appId: null, label: "Platform", features: ["Other"], serviceDesk, feedbackEnabled: false });
    render(<ReportProblemDialog open onOpenChange={jest.fn()} />);
    await screen.findByRole("button", { name: "Request help" });
    expect(screen.queryByText("Request help is unavailable for this component.")).not.toBeInTheDocument();
  });

  it("does not select Request help when ordinary feedback is unavailable", async () => {
    mockFetchFeedbackOptions.mockResolvedValue({ appId: null, label: "Platform", features: ["Other"], serviceDesk, feedbackEnabled: false });
    render(<ReportProblemDialog open onOpenChange={jest.fn()} />);
    expect(await screen.findByRole("button", { name: "Request help" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Bug" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Enhancement" })).toBeDisabled();
    expect(screen.queryByLabelText("Description *")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Request help" }));
    expect(screen.getByLabelText("Description *")).toBeInTheDocument();
  });

  it.each(["feedback", "service-desk"])("retains the submitted %s payload for copy and retry after component changes", async mode => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      let rejectRequest!: (reason: Error) => void;
      mockCreateTicketViaAgent.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRequest = reject; }));
      mockFetchFeedbackComponents.mockImplementation((_url, _conversation, _signal, initial) => Promise.resolve({ appId: initial ?? null,
        components: [{ appId: null, label: "Platform" }, { appId: "example", label: "Example app" }] }));
      mockFetchFeedbackOptions.mockImplementation((_url, _conversation, _signal, component) => Promise.resolve(component === "example"
        ? { appId: "example", label: "Example app", features: ["Other"] }
        : { appId: null, label: "Platform", features: ["Other"], serviceDesk }));
      const { rerender } = render(<ReportProblemDialog open onOpenChange={jest.fn()} />);
      await fillRequiredFields();
      if (mode === "service-desk") {
        fireEvent.click(screen.getByRole("button", { name: "Request help" }));
        fireEvent.change(screen.getByLabelText("Description *"), { target: { value: "Please grant access." } });
        chooseAreas("Vault");
        fireEvent.change(screen.getByLabelText("Namespace path"), { target: { value: "example/apps" } });
      }
      fireEvent.click(screen.getByRole("button", { name: mode === "service-desk" ? "Submit Request" : "Submit Report" }));
      await waitFor(() => expect(mockCreateTicketViaAgent).toHaveBeenCalledTimes(1));
      const submitted = JSON.parse(JSON.stringify(mockCreateTicketViaAgent.mock.calls[0][0].request));
      rerender(<ReportProblemDialog open onOpenChange={jest.fn()} initialComponentId="example" />);
      await waitFor(() => expect(mockFetchFeedbackOptions).toHaveBeenLastCalledWith(expect.any(String), undefined, expect.any(AbortSignal), "example"));
      await act(async () => { rejectRequest(new Error("First attempt failed")); });
      fireEvent.click(await screen.findByRole("button", { name: "Copy Description" }));
      if (mode === "service-desk") {
        expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Please grant access."));
        expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Areas of impact: Vault"));
        expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Vault — Namespace path: example/apps"));
      } else {
        expect(writeText).toHaveBeenCalledWith(submitted.description);
      }
      mockCreateTicketViaAgent.mockRejectedValueOnce(new Error("Original destination unavailable"));
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByText("Original destination unavailable");
      expect(mockCreateTicketViaAgent).toHaveBeenCalledTimes(2);
      expect(mockCreateTicketViaAgent.mock.calls[1][0].request).toEqual(submitted);
      expect(mockCreateTicketViaAgent.mock.calls[1][0].request.componentId).toBeNull();
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("logs the page the retried request was made from, not the current page", async () => {
    const original = window.location.href;
    try {
      window.history.pushState({}, "", "/page-a");
      const pageA = window.location.href;
      mockCreateTicketViaAgent.mockRejectedValueOnce(new Error("First attempt failed"));
      const { rerender } = render(<ReportProblemDialog open onOpenChange={jest.fn()} />);
      await fillRequiredFields();
      fireEvent.click(screen.getByText("Submit Report"));
      await screen.findByText("First attempt failed");

      window.history.pushState({}, "", "/page-b");
      rerender(<ReportProblemDialog open onOpenChange={jest.fn()} />);
      mockCreateTicketViaAgent.mockRejectedValueOnce(new Error("Second attempt failed"));
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByText("Second attempt failed");
      fireEvent.click(screen.getByText(/Show Details/));

      expect(screen.getByText(new RegExp(`Context: ${pageA}$`))).toBeInTheDocument();
      expect(screen.queryByText(/Context: .*\/page-b/)).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, "", original);
    }
  });

  it("is not offered in the chat-feedback flow", async () => {
    render(<ReportProblemDialog open onOpenChange={jest.fn()} feedbackContext={{ reason: "Wrong answer", feedbackType: "dislike" }} />);
    await waitFor(() => expect(screen.getByLabelText("Feature")).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Request help" })).not.toBeInTheDocument();
  });

  it("uses the option lists the server provides", async () => {
    mockFetchFeedbackOptions.mockResolvedValue({ appId: null, label: "Platform", features: ["Other"],
      serviceDesk: { ...serviceDesk, areas: ["Only area"], severities: ["Sev A", "Sev B"], types: ["Request"] } });
    await openRequestHelp();
    fireEvent.click(screen.getByRole("button", { name: "Area of impact" }));
    expect(screen.getByRole("button", { name: "Only area" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Vault" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Severity *")).toHaveValue("Sev A");
    expect(screen.getByLabelText("Type *")).toHaveValue("Request");
  });

  it("shows optional details for the chosen area and sends the filled ones", async () => {
    await openRequestHelp();
    fireEvent.change(screen.getByLabelText("Ticket title *"), { target: { value: "Vault access" } });
    fireEvent.change(screen.getByLabelText("Description *"), { target: { value: "Admin role does not grant access." } });
    expect(screen.queryByText("Optional details")).not.toBeInTheDocument();
    chooseAreas("Vault");
    expect(screen.getByText("Optional details")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Vault" })).toBeInTheDocument();
    expect(screen.getAllByText("optional").length).toBeGreaterThan(1);
    fireEvent.change(screen.getByLabelText("Namespace path"), { target: { value: "example/apps/demo" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "Admin" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit Request" }));
    await waitFor(() => expect(mockCreateTicketViaAgent).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({
      serviceDesk: expect.objectContaining({ areas: ["Vault"], details: [
        { area: "Vault", label: "Namespace path", value: "example/apps/demo" },
        { area: "Vault", label: "Role", value: "Admin" },
      ] }),
    }) })));
  });

  it("drops the details of an area that is no longer chosen", async () => {
    await openRequestHelp();
    fireEvent.change(screen.getByLabelText("Ticket title *"), { target: { value: "Access" } });
    fireEvent.change(screen.getByLabelText("Description *"), { target: { value: "Need access." } });
    chooseAreas("Vault");
    fireEvent.change(screen.getByLabelText("Namespace path"), { target: { value: "example/apps/demo" } });
    chooseAreas("Vault", "Other");
    fireEvent.click(screen.getByRole("button", { name: "Submit Request" }));
    await waitFor(() => expect(mockCreateTicketViaAgent).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({
      serviceDesk: expect.objectContaining({ areas: ["Other"], details: [] }),
    }) })));
  });

  it("says what is still needed until the required fields are filled", async () => {
    await openRequestHelp();
    expect(screen.getByRole("status")).toHaveTextContent("Still needed: ticket title, description, area of impact.");
    fireEvent.change(screen.getByLabelText("Ticket title *"), { target: { value: "Vault access" } });
    expect(screen.getByRole("status")).toHaveTextContent("Still needed: description, area of impact.");
    fireEvent.change(screen.getByLabelText("Description *"), { target: { value: "Need access." } });
    chooseAreas("Vault");
    expect(screen.queryByText(/Still needed/)).not.toBeInTheDocument();
  });

  it("shows a details group for each chosen area", async () => {
    await openRequestHelp();
    chooseAreas("Vault", "AI / ML");
    expect(screen.getByRole("group", { name: "Vault" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "AI / ML" })).toBeInTheDocument();
  });

  it("does not require the details to submit", async () => {
    await openRequestHelp();
    fireEvent.change(screen.getByLabelText("Ticket title *"), { target: { value: "Bucket access" } });
    fireEvent.change(screen.getByLabelText("Description *"), { target: { value: "Need read access." } });
    chooseAreas("Compute");
    fireEvent.click(screen.getByRole("button", { name: "Submit Request" }));
    await waitFor(() => expect(mockCreateTicketViaAgent).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({
      serviceDesk: { areas: ["Compute"], severity: "Medium", type: "Ticket", details: [] },
    }) })));
  });

  it("returns to the feedback form when Bug is chosen", async () => {
    await openRequestHelp();
    fireEvent.click(screen.getByRole("button", { name: "Bug" }));
    expect(screen.getByLabelText("Steps to reproduce *")).toBeInTheDocument();
    expect(screen.queryByLabelText("Description *")).not.toBeInTheDocument();
  });
});
