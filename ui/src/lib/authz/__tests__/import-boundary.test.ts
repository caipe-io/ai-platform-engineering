/** @jest-environment jsdom */
import * as cas from "../index";

// Core CAS callers must not load the HTTP adapter just to use the public API.
jest.mock("next/server", () => {
  throw new Error("CAS core must not import Next.js request/response handling");
});

it("loads the public decision and delegation API without the HTTP runtime", () => {
  for (const name of ["authorize", "authorizeMany", "createDelegation", "inspectDelegation",
    "revokeDelegation", "authorizeDelegated"] as const) {
    expect(cas[name]).toEqual(expect.any(Function));
  }
});
