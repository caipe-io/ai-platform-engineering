import React, { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FeedbackButton, type Feedback } from "../FeedbackButton";

const mockSubmitFeedback = jest.fn();
const mockCreateTicket = jest.fn();
let mockReporting = true;
jest.mock("@/lib/config", () => ({ getConfig: (key: string) => key === "reportProblemEnabled" ? mockReporting : null }));
jest.mock("@/lib/langfuse", () => ({ submitFeedback: (...args: unknown[]) => mockSubmitFeedback(...args) }));
jest.mock("@/lib/ticket-client", () => ({ createTicketViaAgent: (...args: unknown[]) => mockCreateTicket(...args), fetchFeedbackComponents: async () => ({ appId: null, components: [{ appId: null, label: "Platform" }] }), fetchFeedbackOptions: async () => ({ appId: null, label: "Platform", features: ["Other", "Chat", "Content"] }) }));
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { email: "reporter@example.test" } } }) }));
function ChatFeedback() {
  const [feedback, setFeedback] = useState<Feedback>({ type: null });
  return <FeedbackButton messageId="test-message" conversationId="test-conversation" feedback={feedback} onFeedbackChange={setFeedback} />;
}
beforeEach(() => {
  jest.clearAllMocks();
  mockReporting = true;
  mockSubmitFeedback.mockReset().mockResolvedValue({ success: true });
  mockCreateTicket.mockReset().mockResolvedValue({ id: "42", url: "https://example.test/issues/42", provider: "github" });
  window.history.replaceState({}, "", "/apps/example?conversation=test-conversation#test-message");
});
async function openReport() {
  fireEvent.click(screen.getByTitle("Not helpful"));
  if (mockReporting) await waitFor(() => expect(screen.getByLabelText("Feature")).toBeEnabled());
}
function fillReport() {
  fireEvent.change(screen.getByLabelText("Short title *"), { target: { value: "The answer misses a step" } });
  fireEvent.change(screen.getByLabelText("Steps to reproduce *"), { target: { value: "Ask the assistant" } });
  fireEvent.change(screen.getByLabelText("Feature"), { target: { value: "Chat" } });
}
it("opens the complete form on the first thumbs-down click and records nothing on cancel", async () => {
  render(<ChatFeedback />);
  await openReport();
  expect(screen.getByRole("heading", { name: "Provide Feedback" })).toBeInTheDocument();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.queryByText("What went wrong?")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Inaccurate" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Bug" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByLabelText("Feature")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Submit Report" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Close", exact: true }));
  expect(mockSubmitFeedback).not.toHaveBeenCalled();
  expect(mockCreateTicket).not.toHaveBeenCalled();
  await openReport();
  expect(screen.getByRole("heading", { name: "Provide Feedback" })).toBeInTheDocument();
});
it("submits the chosen category, feature, report details and full conversation URL together", async () => {
  render(<ChatFeedback />);
  await openReport();
  fillReport();
  fireEvent.click(screen.getByRole("button", { name: "Minor" }));
  fireEvent.click(screen.getByRole("button", { name: "Submit Report" }));
  await screen.findByRole("heading", { name: "Ticket Created" });
  expect(mockSubmitFeedback).toHaveBeenCalledTimes(1);
  expect(mockSubmitFeedback).toHaveBeenCalledWith(expect.objectContaining({
    feedbackType: "dislike", reason: "Bug", conversationId: "test-conversation", additionalFeedback: expect.stringContaining("Impact: Minor"),
  }));
  expect(mockCreateTicket.mock.calls[0][0].request).toEqual(expect.objectContaining({
    title: "The answer misses a step", issueType: "Bug", feature: "Chat", contextUrl: window.location.href,
    sections: [{ label: "Steps to reproduce", value: "Ask the assistant" }],
    feedbackContext: expect.objectContaining({ feedbackType: "dislike", reason: "Bug" }),
  }));
});
it("retries a failed rating without creating a ticket until the rating succeeds", async () => {
  mockSubmitFeedback.mockResolvedValueOnce({ success: false, message: "Rating unavailable" });
  render(<ChatFeedback />);
  await openReport(); fillReport();
  fireEvent.click(screen.getByRole("button", { name: "Submit Report" }));
  await screen.findByText("Rating unavailable");
  expect(mockCreateTicket).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("heading", { name: "Ticket Created" });
  expect(mockSubmitFeedback).toHaveBeenCalledTimes(2);
  expect(mockCreateTicket).toHaveBeenCalledTimes(1);
});
it("retries ticket creation without recording the rating twice", async () => {
  mockCreateTicket.mockRejectedValueOnce(new Error("App unavailable"));
  render(<ChatFeedback />);
  await openReport(); fillReport();
  fireEvent.click(screen.getByRole("button", { name: "Submit Report" }));
  await screen.findByText("App unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("heading", { name: "Ticket Created" });
  expect(mockSubmitFeedback).toHaveBeenCalledTimes(1);
  expect(mockCreateTicket).toHaveBeenCalledTimes(2);
});
it("prevents duplicate reports while the rating is pending", async () => {
  let finish!: (value: { success: boolean }) => void;
  mockSubmitFeedback.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<ChatFeedback />);
  await openReport(); fillReport();
  const submit = screen.getByRole("button", { name: "Submit Report" });
  fireEvent.click(submit); fireEvent.click(submit);
  expect(mockSubmitFeedback).toHaveBeenCalledTimes(1);
  expect(mockCreateTicket).not.toHaveBeenCalled();
  finish({ success: true });
  await screen.findByRole("heading", { name: "Ticket Created" });
  expect(mockCreateTicket).toHaveBeenCalledTimes(1);
});
it("keeps lightweight response feedback available when reporting is disabled", async () => {
  mockReporting = false;
  render(<ChatFeedback />); await openReport();
  expect(screen.queryByRole("heading", { name: "Provide Feedback" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Inaccurate", exact: true })).toBeInTheDocument();
});
it("records an enhancement with the chosen feature and validates its optional link", async () => {
  render(<ChatFeedback />); await openReport();
  fireEvent.click(screen.getByRole("button", { name: "Enhancement" }));
  expect(screen.queryByLabelText("Steps to reproduce *")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Short title *"), { target: { value: "Add a preview" } });
  fireEvent.change(screen.getByLabelText("What I am trying to do *"), { target: { value: "Review changes before saving" } });
  fireEvent.change(screen.getByLabelText("Feature"), { target: { value: "Content" } });
  fireEvent.change(screen.getByLabelText("Link (optional)"), { target: { value: "javascript:alert(1)" } });
  expect(screen.getByRole("button", { name: "Submit Report" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Link (optional)"), { target: { value: "https://example.test/item" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit Report" }));
  await screen.findByRole("heading", { name: "Ticket Created" });
  expect(mockSubmitFeedback).toHaveBeenCalledWith(expect.objectContaining({ reason: "Enhancement" }));
  expect(mockCreateTicket.mock.calls[0][0].request).toEqual(expect.objectContaining({ issueType: "Enhancement", feature: "Content" }));
});
