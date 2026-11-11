import { fireEvent, render, screen } from "@testing-library/react";
import { CollapsibleAgentText } from "../CollapsibleAgentText";

it("preserves full rendered content and expansion as a reply grows", () => {
  const height = jest.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(360);
  const { rerender } = render(<CollapsibleAgentText><p>First result</p></CollapsibleAgentText>);
  const toggle = screen.getByRole("button", { name: "Show more" });
  expect(screen.getByText("First result").parentElement).toHaveStyle({ maxHeight: "168px" });
  fireEvent.click(toggle);
  rerender(<CollapsibleAgentText><p>First result</p><p>Additional streamed result</p></CollapsibleAgentText>);
  expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("First result").parentElement).not.toHaveStyle({ maxHeight: "168px" });
  expect(screen.getByText("Additional streamed result")).toBeVisible();
  height.mockRestore();
});

it("does not offer expansion for a short reply", () => {
  const height = jest.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(80);
  render(<CollapsibleAgentText><p>Short result</p></CollapsibleAgentText>);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  height.mockRestore();
});
