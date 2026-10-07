import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

import { AccessSubjectMultiPicker } from "../access-subject-picker";

describe("AccessSubjectMultiPicker", () => {
  it("explains implicit owner access instead of presenting it as a selectable grant", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();

    render(
      <AccessSubjectMultiPicker
        teams={[]}
        knownUsers={[
          {
            kind: "user",
            id: "test-user",
            name: "Test User",
            email: "test-user@example.com",
          },
        ]}
        selected={[]}
        implicitSelections={[{ kind: "user", id: "test-user" }]}
        implicitSelectionLabel="Access included through personal ownership"
        onChange={onChange}
        placeholder="Only the personal owner can search — add others"
        ariaLabel="Search access"
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Search access" }),
    ).toHaveTextContent(/Test User.*Access included through personal ownership/);

    await user.click(
      screen.getByRole("combobox", { name: "Search access" }),
    );

    const owner = screen.getByRole("option", { name: /Test User/i });
    expect(owner).toBeDisabled();
    expect(owner).toHaveTextContent(
      "Access included through personal ownership",
    );
    expect(owner.closest('[role="listbox"]')).toHaveClass(
      "max-h-64",
      "overflow-y-auto",
    );

    await user.click(owner);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("labels collection-derived access and keeps it read-only", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();

    render(
      <AccessSubjectMultiPicker
        teams={[{ slug: "everyone", name: "Everyone" }]}
        selected={[]}
        implicitSelections={[{ kind: "team", id: "everyone" }]}
        implicitSelectionLabel={(selection) =>
          selection.id === "everyone" ? "From Platform RAG" : undefined
        }
        onChange={onChange}
        placeholder="No direct Search access"
        ariaLabel="Search access"
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Search access" });
    expect(trigger).toHaveTextContent(/Everyone.*From Platform RAG/);
    await user.click(trigger);

    const everyone = screen.getByRole("option", { name: /Everyone/i });
    expect(everyone).toBeDisabled();
    expect(everyone).toHaveTextContent("From Platform RAG");
    await user.click(everyone);
    expect(onChange).not.toHaveBeenCalled();
  });
});
