/**
 * @jest-environment jsdom
 */

import { render,screen } from "@testing-library/react";

jest.mock("@/components/settings/sections/AppearanceSettings",() => ({ AppearanceSettings: () => <div>Appearance content</div> }));
jest.mock("@/components/settings/sections/ChatSettings",() => ({ ChatSettings: () => <div>Chat content</div> }));
jest.mock("@/components/settings/sections/NotificationsSettings",() => ({ NotificationsSettings: () => <div>Notifications content</div> }));
jest.mock("@/components/settings/sections/AccessSettings",() => ({ AccessSettings: () => <div>Access content</div> }));
jest.mock("@/components/settings/sections/DeveloperSettings",() => ({ DeveloperSettings: () => <div>Developer content</div> }));

import { SettingsWorkspace } from "../SettingsWorkspace";
import { findSettingsRouteBySegment,PERSONAL_SETTINGS_ROUTES } from "../settings-routes";

describe("SettingsWorkspace",() => {
  it("renders the selected section without duplicating the global navigation",() => {
    render(<SettingsWorkspace activeRouteId="appearance" />);

    expect(screen.getByText("Appearance content")).toBeInTheDocument();
    expect(screen.getByRole("region",{ name: "Appearance settings" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation",{ name: "Settings sections" })).not.toBeInTheDocument();
  });

  it("contains only personal settings",() => {
    render(<SettingsWorkspace activeRouteId="chat" />);

    expect(screen.getByText("Chat content")).toBeInTheDocument();
    expect(screen.queryByText("Appearance content")).not.toBeInTheDocument();
    expect(screen.queryByText("Defaults",{ exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("Announcements",{ exact: true })).not.toBeInTheDocument();
    expect(PERSONAL_SETTINGS_ROUTES.some((route) => route.id === "system-health")).toBe(false);
    expect(findSettingsRouteBySegment("system-health")).toBeUndefined();
  });

});
