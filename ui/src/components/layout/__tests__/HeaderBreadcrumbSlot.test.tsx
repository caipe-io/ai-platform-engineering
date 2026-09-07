import { render,screen,within } from "@testing-library/react";

import {
  HeaderBreadcrumbPortal,
  HeaderBreadcrumbSlotProvider,
  useHeaderBreadcrumbSlot,
} from "../HeaderBreadcrumbSlot";

function HeaderSlot(): React.ReactElement {
  const slot = useHeaderBreadcrumbSlot();

  return (
    <div data-testid="breadcrumb-slot" ref={slot?.setTarget}>
      {slot && !slot.hasPortalContent ? <span>Route fallback</span> : null}
    </div>
  );
}

describe("HeaderBreadcrumbSlot", () => {
  it("replaces the route fallback with page-provided breadcrumb content", () => {
    render(
      <HeaderBreadcrumbSlotProvider>
        <HeaderSlot />
        <HeaderBreadcrumbPortal>
          <span>Home / Skills</span>
        </HeaderBreadcrumbPortal>
      </HeaderBreadcrumbSlotProvider>,
    );

    const slot = screen.getByTestId("breadcrumb-slot");
    expect(within(slot).getByText("Home / Skills")).toBeInTheDocument();
    expect(within(slot).queryByText("Route fallback")).not.toBeInTheDocument();
  });

  it("renders inline when used outside the application shell", () => {
    render(
      <HeaderBreadcrumbPortal>
        <span>Inline breadcrumb</span>
      </HeaderBreadcrumbPortal>,
    );

    expect(screen.getByText("Inline breadcrumb")).toBeInTheDocument();
  });
});
