import { fireEvent, render, screen } from "@testing-library/react";

import { AgentPicker } from "../agent-picker";

describe("AgentPicker", () => {
  it("maps domain IDs and labels onto the shared picker", () => {
    const onChange = jest.fn();
    render(
      <AgentPicker
        ariaLabel="Example agent"
        options={[
          { value: "agent-primary", label: "Primary Agent" },
          { value: "agent-secondary", label: "Secondary Agent" },
        ]}
        value="agent-primary"
        onChange={onChange}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Example agent" })).toHaveTextContent(
      "Primary Agentagent:agent-primary",
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Example agent" }));
    fireEvent.click(screen.getByRole("option", { name: /Secondary Agent/ }));
    expect(onChange).toHaveBeenCalledWith("agent-secondary");
  });

  it("passes required and custom clear-value behavior through the adapter", () => {
    const onChange = jest.fn();
    const { rerender } = render(
      <AgentPicker
        ariaLabel="Required agent"
        options={[{ value: "agent-primary", label: "Primary Agent" }]}
        value="agent-primary"
        onChange={onChange}
        required
      />,
    );

    expect(screen.getByRole("combobox", { name: "Required agent" })).toHaveAttribute(
      "aria-required",
      "true",
    );
    expect(screen.queryByRole("button", { name: "Clear agent selection" })).not.toBeInTheDocument();

    rerender(
      <AgentPicker
        ariaLabel="Optional agent"
        options={[{ value: "agent-primary", label: "Primary Agent" }]}
        value="agent-primary"
        onChange={onChange}
        clearValue="deployment-default"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear agent selection" }));
    expect(onChange).toHaveBeenCalledWith("deployment-default");

    rerender(
      <AgentPicker
        ariaLabel="Default agent"
        options={[
          { value: "deployment-default", label: "Use deployment default" },
          { value: "agent-primary", label: "Primary Agent" },
        ]}
        value="deployment-default"
        onChange={onChange}
        clearValue="deployment-default"
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Clear agent selection" }),
    ).not.toBeInTheDocument();
  });
});
