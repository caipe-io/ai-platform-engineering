import { fireEvent, render, screen } from "@testing-library/react";

import { RewindConfirmationDialog } from "../RewindConfirmationDialog";

describe("RewindConfirmationDialog", () => {
  it("warns how many later messages will be permanently removed", () => {
    render(
      <RewindConfirmationDialog
        open
        messageCount={4}
        isConfirming={false}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Rewind conversation?" })).toBeInTheDocument();
    expect(screen.getByText("Messages will be permanently deleted.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This message and the 3 messages after it will be lost and cannot be recovered.",
      ),
    ).toBeInTheDocument();
  });

  it("requires explicit confirmation before rewinding", () => {
    const onCancel = jest.fn();
    const onConfirm = jest.fn();
    render(
      <RewindConfirmationDialog
        open
        messageCount={1}
        isConfirming={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    expect(
      screen.getByText("This message will be lost and cannot be recovered."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Rewind and send" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
