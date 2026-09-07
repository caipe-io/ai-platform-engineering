import { fireEvent, render, screen, within } from "@testing-library/react";

import { TeamMultiPicker, TeamPicker } from "../team-picker";

const TEAMS = [
  { slug: "primary", name: "Primary Team" },
  { slug: "secondary", name: "Secondary Team" },
  { slug: "external-admin", name: "External Admin", _id: "team-record-1" },
];

describe("TeamPicker", () => {
  it("resolves legacy record IDs while rendering the canonical team subject", () => {
    render(
      <TeamPicker
        ariaLabel="Owner team"
        options={TEAMS}
        value="team-record-1"
        onChange={jest.fn()}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Owner team" })).toHaveTextContent(
      "External Adminteam:external-admin",
    );
  });

  it("emits the canonical slug for a selected legacy-shaped option", () => {
    const onChange = jest.fn();
    render(
      <TeamPicker
        ariaLabel="Owner team"
        options={TEAMS}
        value=""
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Owner team" }));
    fireEvent.click(screen.getByRole("option", { name: /External Admin/ }));
    expect(onChange).toHaveBeenCalledWith("external-admin");
  });
});

describe("TeamMultiPicker", () => {
  it("keeps selected teams compact and preserves unresolved subjects", () => {
    render(
      <TeamMultiPicker
        ariaLabel="Shared teams"
        options={TEAMS}
        selected={["primary", "secondary", "removed-team"]}
        onChange={jest.fn()}
        triggerChipCap={2}
      />,
    );

    expect(screen.getByText("Primary Team")).toBeInTheDocument();
    expect(screen.getByText("Secondary Team")).toBeInTheDocument();
    expect(screen.getByText("+1 more")).toBeInTheDocument();
  });

  it("groups, filters, and toggles canonical team subjects", () => {
    const onChange = jest.fn();
    render(
      <TeamMultiPicker
        ariaLabel="Shared teams"
        options={TEAMS}
        selected={["primary"]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Shared teams" }));
    const listbox = screen.getByRole("listbox", { name: "Shared teams" });
    expect(
      screen.getByRole("searchbox", { name: "Search teams..." }),
    ).toHaveFocus();
    expect(within(listbox).getAllByRole("option")[0]).toHaveAccessibleName(
      /Primary Team/,
    );
    fireEvent.change(screen.getByRole("searchbox", { name: "Search teams..." }), {
      target: { value: "external" },
    });
    fireEvent.click(screen.getByRole("option", { name: /External Admin/ }));
    expect(onChange).toHaveBeenCalledWith(["primary", "external-admin"]);
  });

  it("removes one subject without opening the picker", () => {
    const onChange = jest.fn();
    render(
      <TeamMultiPicker
        ariaLabel="Shared teams"
        options={TEAMS}
        selected={["primary", "secondary"]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove Primary Team" }));
    expect(onChange).toHaveBeenCalledWith(["secondary"]);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps selected subjects removable at the selection limit", () => {
    const onChange = jest.fn();
    render(
      <TeamMultiPicker
        ariaLabel="Shared teams"
        options={TEAMS}
        selected={["primary"]}
        onChange={onChange}
        maxSelections={1}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Shared teams" }));
    expect(screen.getByRole("option", { name: /Secondary Team/ })).toBeDisabled();
    expect(screen.getByRole("option", { name: /Primary Team/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /^Clear all$/ }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
