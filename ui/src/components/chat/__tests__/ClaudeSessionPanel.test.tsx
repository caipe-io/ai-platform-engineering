import { render, screen } from "@testing-library/react";
import { ClaudeSessionPanel } from "../ClaudeSessionPanel";

it("shows reconnection progress and shared-viewer restrictions", () => {
  const { rerender } = render(<ClaudeSessionPanel activity="checking" readOnly />);
  expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
  expect(screen.getByText("Viewing shared session")).toBeInTheDocument();
  expect(screen.getByText(/Sending messages or stopping work requires additional access/)).toBeInTheDocument();
  rerender(<ClaudeSessionPanel activity="running" readOnly={false} />);
  expect(screen.getByRole("status")).toHaveTextContent("Working");
  expect(screen.queryByText("Viewing shared session")).not.toBeInTheDocument();
  expect(screen.getByText(/Refreshing or closing this page does not stop a response/)).toBeInTheDocument();
});
