import { act, renderHook } from "@testing-library/react";
import { useAgentCatalogCardSize, useAgentCatalogView } from "../use-agent-catalog-view";

let mockSubject = "first-user";
jest.mock("next-auth/react", () => ({ useSession: () => ({ data: { sub: mockSubject } }) }));

beforeEach(() => { localStorage.clear(); mockSubject = "first-user"; });

it("defaults to Grid and restores an explicit List preference for only its user", () => {
  const { result, rerender } = renderHook(() => useAgentCatalogView());
  expect(result.current[0]).toBe("grid");
  act(() => result.current[1]("list"));
  expect(localStorage.getItem("caipe:agent-catalog-view:first-user")).toBe("list");
  mockSubject = "second-user";
  rerender();
  expect(result.current[0]).toBe("grid");
  mockSubject = "first-user";
  rerender();
  expect(result.current[0]).toBe("list");
});

it("retains the selected view when browser storage is unavailable", () => {
  const failure = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage disabled"); });
  const { result } = renderHook(() => useAgentCatalogView());
  act(() => result.current[1]("list"));
  expect(result.current[0]).toBe("list");
  failure.mockRestore();
});


it("restores card size after remount without sharing it with another account", () => {
  const first = renderHook(() => useAgentCatalogCardSize());
  expect(first.result.current[0]).toBe("balanced");
  act(() => first.result.current[1]("comfortable"));
  first.unmount();
  const { result, rerender } = renderHook(() => useAgentCatalogCardSize());
  expect(result.current[0]).toBe("comfortable");
  mockSubject = "second-user";
  rerender();
  expect(result.current[0]).toBe("balanced");
  act(() => result.current[1]("compact"));
  mockSubject = "first-user";
  rerender();
  expect(result.current[0]).toBe("comfortable");
});

it("ignores invalid saved sizes and synchronizes changes from another tab", () => {
  const key = "caipe:agent-catalog-card-size:first-user";
  localStorage.setItem(key, "invalid");
  const { result } = renderHook(() => useAgentCatalogCardSize());
  expect(result.current[0]).toBe("balanced");
  act(() => {
    localStorage.setItem(key, "compact");
    window.dispatchEvent(new StorageEvent("storage", { key }));
  });
  expect(result.current[0]).toBe("compact");
  act(() => {
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });
  expect(result.current[0]).toBe("balanced");
});

it("keeps card size usable if saving browser preferences fails", () => {
  const failure = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage disabled"); });
  const { result } = renderHook(() => useAgentCatalogCardSize());
  act(() => result.current[1]("comfortable"));
  expect(result.current[0]).toBe("comfortable");
  failure.mockRestore();
});
