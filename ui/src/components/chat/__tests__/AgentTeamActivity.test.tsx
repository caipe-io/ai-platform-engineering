import { fireEvent, render, screen } from "@testing-library/react";
import { AgentTeamActivity } from "../AgentTeamActivity";

it("collapses finished work while keeping children mounted and the final answer separate", () => {
  const view = (complete: boolean, grouped = true) => <>
    <AgentTeamActivity count={2} complete={complete} grouped={grouped}><input aria-label="Work detail" defaultValue="preserved" /></AgentTeamActivity>
    <p>Primary final answer</p>
  </>;
  const { rerender } = render(view(false));
  const input = screen.getByRole("textbox");
  rerender(view(true));
  expect(input).not.toBeVisible();
  expect(screen.getByText("Primary final answer")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Agent Team activity/ }));
  expect(input).toBeVisible();
  rerender(view(true, false));
  expect(screen.getByRole("textbox")).toBe(input);
  expect(input).toHaveValue("preserved");
});
