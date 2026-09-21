/**
 * @jest-environment jsdom
 */

import { fireEvent,render,screen } from "@testing-library/react";

const replaceMock = jest.fn();
let mockSearchParams = new URLSearchParams();

jest.mock("next/navigation",() => ({
  usePathname: () => "/admin/security/audit",
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => mockSearchParams,
}));

import { SecurityWorkspaceTabs } from "../SecurityWorkspaceTabs";

const ITEMS = [
  { id: "rbac",label: "RBAC",content: <div>RBAC content</div> },
  { id: "chat",label: "Chat",content: <div>Chat content</div> },
];

describe("SecurityWorkspaceTabs",() => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  it("selects and canonicalizes the first available section",() => {
    render(<SecurityWorkspaceTabs ariaLabel="Audit sections" items={ITEMS} queryKey="auditTab" />);

    expect(screen.getByText("RBAC content")).toBeInTheDocument();
    expect(replaceMock).toHaveBeenCalledWith(
      "/admin/security/audit?auditTab=rbac",
      { scroll: false },
    );
  });

  it("uses a valid URL selection and updates it from the submenu",() => {
    mockSearchParams = new URLSearchParams("auditTab=chat");
    render(<SecurityWorkspaceTabs ariaLabel="Audit sections" items={ITEMS} queryKey="auditTab" />);

    expect(screen.getByText("Chat content")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByRole("tab",{ name: "RBAC" }),{
      button: 0,
      ctrlKey: false,
    });
    expect(replaceMock).toHaveBeenCalledWith(
      "/admin/security/audit?auditTab=rbac",
      { scroll: false },
    );
  });
});
