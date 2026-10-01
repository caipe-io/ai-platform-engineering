import { redirect } from "next/navigation";

import LegacyAgentBuilderHistoryRedirectPage from "../history/page";
import LegacyAgentBuilderRedirectPage from "../page";

jest.mock("next/navigation", () => ({
  redirect: jest.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

const mockRedirect = redirect as unknown as jest.Mock;

describe("legacy Agentic Workflows redirects", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ["/agent-builder", LegacyAgentBuilderRedirectPage],
    ["/agent-builder/history", LegacyAgentBuilderHistoryRedirectPage],
  ])("redirects %s to the Skills Gallery", (_route, page) => {
    expect(page).toThrow("redirect:/skills");
    expect(mockRedirect).toHaveBeenCalledWith("/skills");
  });
});
