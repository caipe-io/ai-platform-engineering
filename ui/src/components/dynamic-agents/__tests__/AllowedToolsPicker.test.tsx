import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

import { AllowedToolsPicker } from "../AllowedToolsPicker";

type Selection = Record<string, string[] | boolean>;
const catalog = ["lookup", "status"].map((name) => ({ name, namespaced_name: name }));
const response = (tools: unknown = catalog) => ({
  ok: true,
  json: async () => ({ success: true, data: { success: true, tools } }),
});

function setup(initial: Selection = {}) {
  const changed = jest.fn();
  function Draft() {
    const [value, setValue] = React.useState(initial);
    return <AllowedToolsPicker value={value} onChange={(next) => { changed(next); setValue(next); }} />;
  }
  const rendered = render(<Draft />);
  return { ...rendered, changed };
}

beforeEach(() => {
  global.fetch = jest.fn().mockImplementation((url: string) => Promise.resolve(
    url.includes("/probe?") ? response() : {
      ok: true,
      json: async () => ({ success: true, data: { items: [
        { _id: "primary", name: "Primary", enabled: true },
        { _id: "secondary", name: "Secondary", enabled: true },
      ] } }),
    },
  ));
});

it("selects a server's discovered tool names and keeps a complete selection explicit", async () => {
  const { changed } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Select tools from Primary" }));
  await waitFor(() => expect(changed).toHaveBeenLastCalledWith({ primary: ["lookup", "status"] }));
  expect(fetch).toHaveBeenCalledWith("/api/mcp-servers/probe?id=primary&list_only=true", expect.objectContaining({ method: "POST" }));
  fireEvent.click(screen.getByRole("button", { name: "Select lookup" }));
  expect(changed).toHaveBeenLastCalledWith({ primary: ["status"] });
  fireEvent.click(screen.getByRole("button", { name: "Select lookup" }));
  expect(changed).toHaveBeenLastCalledWith({ primary: ["status", "lookup"] });
  fireEvent.click(screen.getByRole("button", { name: "Select lookup" }));
  fireEvent.click(screen.getByRole("button", { name: "Select all listed tools" }));
  expect(changed).toHaveBeenLastCalledWith({ primary: ["lookup", "status"] });
  fireEvent.click(screen.getByRole("button", { name: "Select tools from Primary" }));
  expect(changed).toHaveBeenLastCalledWith({});
});

it.each([true, []])("preserves existing wildcard %j until the user explicitly selects the listed tools", async (legacy) => {
  const { changed } = setup({ primary: legacy });
  fireEvent.click(await screen.findByRole("button", { name: "Primary" }));
  await screen.findByRole("button", { name: "Select lookup" });
  expect(changed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Select all listed tools" }));
  expect(changed).toHaveBeenLastCalledWith({ primary: ["lookup", "status"] });
});

it.each([true, [], ["lookup"]])("removes the server when its final tool is unchecked (%j)", async (initial) => {
  jest.mocked(fetch).mockResolvedValueOnce({
    ok: true, json: async () => ({ success: true, data: { items: [{ _id: "primary", name: "Primary", enabled: true }] } }),
  } as Response).mockResolvedValueOnce(response([catalog[0]]) as Response);
  const { changed } = setup({ primary: initial });
  fireEvent.click(await screen.findByRole("button", { name: "Primary" }));
  fireEvent.click(await screen.findByRole("button", { name: "Select lookup" }));
  expect(changed).toHaveBeenLastCalledWith({});
});

it.each([
  ["unavailable", { ok: false, json: async () => ({ success: false, error: "Catalog unavailable" }) }, "Catalog unavailable"],
  ["empty", response([]), "No tools found"],
  ["invalid", response([{ name: "*" }]), "Server returned an invalid tool list"],
  ["failed", { ok: true, json: async () => ({ success: true, data: { success: false, error: "Catalog failed" } }) }, "Catalog failed"],
])("keeps a server unselected when its catalog is %s", async (_label, result, message) => {
  const { changed } = setup();
  const select = await screen.findByRole("button", { name: "Select tools from Primary" });
  jest.mocked(fetch).mockResolvedValueOnce(result as Response);
  fireEvent.click(select);
  await screen.findByText(message as string);
  expect(changed).not.toHaveBeenCalled();
  expect(select).toHaveAttribute("aria-pressed", "false");
});

it("merges concurrent server selections and deduplicates catalog requests", async () => {
  const { changed } = setup();
  const select = await screen.findByRole("button", { name: "Select tools from Primary" });
  let resolve!: (result: Response) => void;
  jest.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
  fireEvent.click(select);
  fireEvent.click(screen.getByRole("button", { name: /^Primary/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Primary/ }));
  fireEvent.click(screen.getByRole("button", { name: "Select tools from Secondary" }));
  await waitFor(() => expect(changed).toHaveBeenLastCalledWith({ secondary: ["lookup", "status"] }));
  await act(async () => { resolve(response() as Response); });
  expect(changed).toHaveBeenLastCalledWith({ secondary: ["lookup", "status"], primary: ["lookup", "status"] });
  expect(jest.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("id=primary"))).toHaveLength(1);
});

it.each(["disabled", "replaced", "unmounted"])("does not apply a pending selection after the draft is %s", async (state) => {
  const changed = jest.fn();
  const { rerender, unmount } = render(<AllowedToolsPicker value={{}} onChange={changed} />);
  const select = await screen.findByRole("button", { name: "Select tools from Primary" });
  let resolve!: (result: Response) => void;
  jest.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
  fireEvent.click(select);
  if (state === "unmounted") unmount();
  else rerender(<AllowedToolsPicker value={state === "replaced" ? { primary: ["other"] } : {}} onChange={changed} disabled={state === "disabled"} />);
  await act(async () => { resolve(response() as Response); });
  expect(changed).not.toHaveBeenCalled();
});

it("refreshes the catalog without silently granting new tools", async () => {
  const { changed } = setup({ primary: ["lookup"] });
  fireEvent.click(await screen.findByRole("button", { name: "Primary" }));
  await screen.findByRole("button", { name: "Select status" });
  expect(screen.getByRole("button", { name: "Select status" })).toHaveAttribute("aria-pressed", "false");
  expect(changed).not.toHaveBeenCalled();
});
