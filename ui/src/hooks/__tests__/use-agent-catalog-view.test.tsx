import { act, renderHook } from "@testing-library/react";
import { useAgentCatalogView } from "../use-agent-catalog-view";

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
