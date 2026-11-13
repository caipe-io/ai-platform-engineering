import { fireEvent, render, screen } from "@testing-library/react";
import { RemoteAgentCatalogCard } from "../RemoteAgentCatalogCard";
import type { RemoteAgentRegistryEntry } from "@/types/dynamic-agent";

const item = { _id: "example", name: "Example remote", description: "Example specialist", timeout_seconds: 120, framework: "unspecified" } as RemoteAgentRegistryEntry;

it("opens an editable remote connection in one click without submitting a surrounding form", () => {
  const onEdit = jest.fn(), onDetails = jest.fn(), onTest = jest.fn(), onSubmit = jest.fn(event => event.preventDefault());
  render(<form onSubmit={onSubmit}><RemoteAgentCatalogCard item={item} canManage busy={false} onEdit={onEdit} onDetails={onDetails} onTest={onTest} /></form>);
  fireEvent.click(screen.getByRole("button", { name: "Open Example remote", exact: true }));
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onDetails).not.toHaveBeenCalled();
  expect(onTest).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
});

it("opens details for a viewer and never offers edit access", () => {
  const onEdit = jest.fn(), onDetails = jest.fn();
  render(<RemoteAgentCatalogCard item={item} canManage={false} busy={false} onEdit={onEdit} onDetails={onDetails} onTest={jest.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Open Example remote", exact: true }));
  expect(onDetails).toHaveBeenCalledTimes(1);
  expect(onEdit).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Edit Example remote" })).not.toBeInTheDocument();
});

it("keeps Details and Test separate from the card's edit action", () => {
  const onEdit = jest.fn(), onDetails = jest.fn(), onTest = jest.fn();
  render(<RemoteAgentCatalogCard item={item} canManage busy={false} onEdit={onEdit} onDetails={onDetails} onTest={onTest} />);
  fireEvent.click(screen.getByRole("button", { name: "Details for Example remote", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Test connection", exact: true }));
  expect(onDetails).toHaveBeenCalledTimes(1);
  expect(onTest).toHaveBeenCalledTimes(1);
  expect(onEdit).not.toHaveBeenCalled();
});

it("does not activate a busy card", () => {
  const onEdit = jest.fn();
  render(<RemoteAgentCatalogCard item={item} canManage busy onEdit={onEdit} onDetails={jest.fn()} onTest={jest.fn()} />);
  const trigger = screen.getByRole("button", { name: "Open Example remote", exact: true });
  expect(trigger).toBeDisabled();
  fireEvent.click(trigger);
  expect(onEdit).not.toHaveBeenCalled();
});
