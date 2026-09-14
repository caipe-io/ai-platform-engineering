import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SearchablePicker } from "../searchable-picker";

interface Option {
  id: string;
  name: string;
  disabled?: boolean;
}

const OPTIONS: Option[] = [
  { id: "primary", name: "Primary" },
  { id: "disabled", name: "Disabled", disabled: true },
  { id: "secondary", name: "Secondary" },
];

function ExamplePicker({
  options = OPTIONS,
  selected,
  onSelect = jest.fn(),
  ...props
}: {
  options?: Option[];
  selected?: Option;
  onSelect?: (option: Option) => void;
} & Partial<React.ComponentProps<typeof SearchablePicker<Option>>>) {
  return (
    <SearchablePicker
      options={options}
      selected={selected}
      onSelect={onSelect}
      getOptionKey={(option) => option.id}
      getOptionLabel={(option) => option.name}
      getSearchText={(option) => [option.id, option.name]}
      isOptionDisabled={(option) => Boolean(option.disabled)}
      placeholder="Select an item"
      searchPlaceholder="Search items"
      emptyLabel="No items match"
      ariaLabel="Example picker"
      {...props}
    />
  );
}

describe("SearchablePicker", () => {
  it("filters and selects options while keeping the domain value opaque", async () => {
    const user = userEvent.setup();
    const onSelect = jest.fn();
    render(<ExamplePicker onSelect={onSelect} />);

    await user.click(screen.getByRole("combobox", { name: "Example picker" }));
    await user.type(screen.getByRole("searchbox", { name: "Search items" }), "second");

    const listbox = screen.getByRole("listbox", { name: "Example picker" });
    expect(within(listbox).getAllByRole("option")).toHaveLength(1);
    await user.click(within(listbox).getByRole("option", { name: "Secondary" }));

    expect(onSelect).toHaveBeenCalledWith(OPTIONS[2]);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Example picker" })).toHaveFocus();
  });

  it("supports arrow, Home, End, Enter, and Escape keyboard behavior", () => {
    const onSelect = jest.fn();
    render(<ExamplePicker onSelect={onSelect} />);

    const trigger = screen.getByRole("combobox", { name: "Example picker" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const search = screen.getByRole("searchbox", { name: "Search items" });
    const primary = screen.getByRole("option", { name: "Primary" });
    const secondary = screen.getByRole("option", { name: "Secondary" });

    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "End" });
    expect(search).toHaveAttribute("aria-activedescendant", secondary.id);
    fireEvent.keyDown(search, { key: "Home" });
    expect(search).toHaveAttribute("aria-activedescendant", primary.id);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search).toHaveAttribute("aria-activedescendant", secondary.id);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(OPTIONS[2]);

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("exposes required, invalid, described-by, disabled, and clear contracts", async () => {
    const user = userEvent.setup();
    const onClear = jest.fn();
    const { rerender } = render(
      <ExamplePicker
        selected={OPTIONS[0]}
        required
        ariaInvalid
        ariaDescribedBy="picker-error"
        onClear={onClear}
      />,
    );

    const required = screen.getByRole("combobox", { name: "Example picker" });
    expect(required).toHaveAttribute("aria-required", "true");
    expect(required).toHaveAttribute("aria-invalid", "true");
    expect(required).toHaveAttribute("aria-describedby", "picker-error");
    expect(screen.queryByRole("button", { name: "Clear selection" })).not.toBeInTheDocument();

    rerender(
      <ExamplePicker selected={OPTIONS[0]} onClear={onClear} disabled />,
    );
    expect(screen.getByRole("combobox", { name: "Example picker" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Clear selection" })).not.toBeInTheDocument();

    rerender(<ExamplePicker selected={OPTIONS[0]} onClear={onClear} />);
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("renders loading, error, retry, empty, and incremental loading states", async () => {
    const user = userEvent.setup();
    const onRetry = jest.fn();
    const onLoadMore = jest.fn();
    const { rerender } = render(
      <ExamplePicker options={[]} loading loadingLabel="Loading resources" />,
    );

    await user.click(screen.getByRole("combobox", { name: "Example picker" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading resources");

    rerender(
      <ExamplePicker options={[]} error="Resources unavailable" onRetry={onRetry} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Resources unavailable");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<ExamplePicker options={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("No items match");

    rerender(
      <ExamplePicker hasMore onLoadMore={onLoadMore} loadMoreLabel="Load next page" />,
    );
    await user.click(screen.getByRole("button", { name: "Load next page" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    rerender(
      <ExamplePicker
        hasMore
        loadingMore
        onLoadMore={onLoadMore}
        loadingLabel="Loading next page"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Loading next page" }),
    ).toBeDisabled();
  });

  it("can delegate search to a paginated domain adapter", async () => {
    const user = userEvent.setup();
    const onSearchChange = jest.fn();
    render(
      <ExamplePicker
        options={[OPTIONS[0]]}
        filterOptions={false}
        onSearchChange={onSearchChange}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Example picker" }));
    await user.type(screen.getByRole("searchbox"), "missing");

    expect(screen.getByRole("option", { name: "Primary" })).toBeInTheDocument();
    expect(onSearchChange).toHaveBeenLastCalledWith("missing");
  });
});
