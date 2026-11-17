import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { MessageActionDeclaration } from "../../../../app-sdk/assistant-options.mjs";
import { MessageActionButtons } from "../MessageActionButtons";

const mockToast = jest.fn();
const mockPost = jest.fn();
jest.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: mockToast }) }));
jest.mock("@/lib/api-client", () => ({ postAssistantAction: (...args: unknown[]) => mockPost(...args) }));

const plain: MessageActionDeclaration = { id: "mark", label: "Mark answer", icon: "check", path: "/api/example/actions/mark" };
const withDialog: MessageActionDeclaration = {
  id: "flag-answer", label: "Flag answer", icon: "flag", path: "/api/example/actions/flag",
  dialog: {
    title: "Flag this answer", description: "Edit the text to give a corrected answer.", submitLabel: "Submit flag",
    field: { label: "Corrected answer", prefill: "message", optional: false, maxLength: 30 },
  },
};

function renderActions(actions: MessageActionDeclaration[], messageContent = "The original answer") {
  return render(
    <MessageActionButtons actions={actions} conversationId="chat-1" agentId="example-agent" messageId="a1" messageContent={messageContent} />,
  );
}
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPost.mockResolvedValue({ ok: true });
});

describe("an action without a dialog", () => {
  it("calls the app at once and confirms success", async () => {
    renderActions([plain]);
    fireEvent.click(screen.getByRole("button", { name: "Mark answer" }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith("Mark answer: done", "success"));
    expect(mockPost).toHaveBeenCalledWith({
      conversationId: "chat-1", agentId: "example-agent", messageId: "a1", actionId: "mark", text: undefined,
    });
  });

  it("shows the app's own success text when it sends one", async () => {
    mockPost.mockResolvedValue({ ok: true, message: "Added to the review set" });
    renderActions([plain]);
    fireEvent.click(screen.getByRole("button", { name: "Mark answer" }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith("Added to the review set", "success"));
  });

  it("is busy and disabled while pending, then usable again", async () => {
    const pending = deferred();
    mockPost.mockReturnValue(pending.promise);
    renderActions([plain]);
    const button = screen.getByRole("button", { name: "Mark answer" });
    expect(button).toHaveAttribute("aria-busy", "false");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
    await act(async () => { pending.resolve({ ok: true }); });
    expect(button).toHaveAttribute("aria-busy", "false");
    expect(button).toBeEnabled();
  });

  it("sends one call for a double click", async () => {
    const pending = deferred();
    mockPost.mockReturnValue(pending.promise);
    renderActions([plain]);
    const button = screen.getByRole("button", { name: "Mark answer" });
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => { pending.resolve({ ok: true }); });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("shows the app's error and lets the user try again", async () => {
    mockPost.mockResolvedValueOnce({ ok: false, error: "Already recorded" });
    renderActions([plain]);
    const button = screen.getByRole("button", { name: "Mark answer" });
    fireEvent.click(button);
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith("Already recorded", "error"));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
  });

  it("falls back to a generic message when the failure has no text", async () => {
    mockPost.mockResolvedValue({ ok: false });
    renderActions([plain]);
    fireEvent.click(screen.getByRole("button", { name: "Mark answer" }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith("The action could not be completed", "error"));
  });

  it("renders declared text literally, never as markup", () => {
    renderActions([{ ...plain, label: "<b>Mark</b>" }]);
    expect(screen.getByRole("button", { name: "<b>Mark</b>" })).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
  });

  it("renders one control per action", () => {
    renderActions([plain, withDialog]);
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });
});

describe("an action with a dialog", () => {
  const open = () => {
    fireEvent.click(screen.getByRole("button", { name: "Flag answer" }));
    return screen.getByRole("dialog");
  };

  it("opens a dialog prefilled with the answer and does not call the app yet", () => {
    renderActions([withDialog]);
    const dialog = open();
    expect(within(dialog).getByText("Flag this answer")).toBeInTheDocument();
    expect(within(dialog).getByText("Edit the text to give a corrected answer.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Corrected answer")).toHaveValue("The original answer");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("starts empty when the field does not prefill", () => {
    renderActions([{ ...withDialog, dialog: { ...withDialog.dialog!, field: { ...withDialog.dialog!.field, prefill: "empty" } } }]);
    expect(within(open()).getByLabelText("Corrected answer")).toHaveValue("");
  });

  it("sends the edited text and closes with a confirmation", async () => {
    renderActions([withDialog]);
    const dialog = open();
    fireEvent.change(within(dialog).getByLabelText("Corrected answer"), { target: { value: "A better answer" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Submit flag" }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(expect.objectContaining({ actionId: "flag-answer", text: "A better answer" })));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockToast).toHaveBeenCalledWith("Flag answer: done", "success");
  });

  it("blocks an empty required field", () => {
    renderActions([withDialog]);
    const dialog = open();
    fireEvent.change(within(dialog).getByLabelText("Corrected answer"), { target: { value: "   " } });
    expect(within(dialog).getByRole("button", { name: "Submit flag" })).toBeDisabled();
  });

  it("allows an empty optional field", async () => {
    renderActions([{ ...withDialog, dialog: { ...withDialog.dialog!, field: { ...withDialog.dialog!.field, optional: true, prefill: "empty" } } }]);
    const dialog = open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Submit flag" }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(expect.objectContaining({ text: "" })));
  });

  it("blocks text over the limit and tells the user the limit", () => {
    renderActions([withDialog], "x".repeat(31));
    const dialog = open();
    expect(within(dialog).getByRole("button", { name: "Submit flag" })).toBeDisabled();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("30 characters or fewer (now 31)");
    expect(within(dialog).getByLabelText("Corrected answer")).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(within(dialog).getByLabelText("Corrected answer"), { target: { value: "x".repeat(30) } });
    expect(within(dialog).getByRole("button", { name: "Submit flag" })).toBeEnabled();
  });

  it("keeps the dialog open and shows the app's error", async () => {
    mockPost.mockResolvedValue({ ok: false, error: "Already recorded" });
    renderActions([withDialog]);
    const dialog = open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Submit flag" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Already recorded");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Submit flag" })).toBeEnabled();
  });

  it("cancels without calling the app", async () => {
    renderActions([withDialog]);
    fireEvent.click(within(open()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("closes on Escape and returns focus to the control", async () => {
    renderActions([withDialog]);
    const trigger = screen.getByRole("button", { name: "Flag answer" });
    const dialog = open();
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("cannot be dismissed or resubmitted while the call is pending", async () => {
    const pending = deferred();
    mockPost.mockReturnValue(pending.promise);
    renderActions([withDialog]);
    const dialog = open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Submit flag" }));
    expect(within(dialog).getByRole("button", { name: "Submit flag" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => { pending.resolve({ ok: true }); });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("refills from the answer each time the dialog opens", async () => {
    renderActions([withDialog]);
    let dialog = open();
    fireEvent.change(within(dialog).getByLabelText("Corrected answer"), { target: { value: "draft" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    dialog = open();
    expect(within(dialog).getByLabelText("Corrected answer")).toHaveValue("The original answer");
  });
});
