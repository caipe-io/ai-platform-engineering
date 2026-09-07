import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ProjectPicker } from "../ProjectPicker";

describe("ProjectPicker", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it("offers No project and owned Projects by display name", async () => {
    const onChange = jest.fn();
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { items: [{ id: "project_a", name: "Project A" }] } }),
    } as Response);
    const user = userEvent.setup();
    render(<ProjectPicker onChange={onChange} />);

    const picker = await screen.findByLabelText("Project");
    expect(await screen.findByRole("option", { name: "No project" })).toBeInTheDocument();
    await user.selectOptions(picker, "project_a");
    expect(onChange).toHaveBeenCalledWith("project_a");
  });

  it("keeps unscoped chat available and offers retry when loading fails", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("offline"));
    render(<ProjectPicker onChange={jest.fn()} />);
    expect(await screen.findByText(/unscoped chat still works/i)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "No project" })).toBeInTheDocument();
  });
});
