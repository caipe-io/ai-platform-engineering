import {
  Bell,
  Bot,
  Code2,
  KeyRound,
  Palette,
  type LucideIcon,
} from "lucide-react";

export type SettingsRouteId =
  | "appearance"
  | "chat"
  | "notifications"
  | "access"
  | "developer";

export interface SettingsRouteDefinition {
  description: string;
  icon: LucideIcon;
  href: string;
  id: SettingsRouteId;
  label: string;
  segment: string;
}

export const PERSONAL_SETTINGS_ROUTES: SettingsRouteDefinition[] = [
  {
    id: "appearance",
    href: "/settings/appearance",
    segment: "appearance",
    label: "Appearance",
    description: "Theme, typography, and interface style.",
    icon: Palette,
  },
  {
    id: "chat",
    href: "/settings/chat-and-agents",
    segment: "chat-and-agents",
    label: "Chat & agents",
    description: "Default agents and conversation behavior.",
    icon: Bot,
  },
  {
    id: "notifications",
    href: "/settings/notifications",
    segment: "notifications",
    label: "Notifications",
    description: "Choose the updates you want to see.",
    icon: Bell,
  },
  {
    id: "access",
    href: "/settings/account-and-access",
    segment: "account-and-access",
    label: "Account & access",
    description: "Your role, teams, and linked identity.",
    icon: KeyRound,
  },
  {
    id: "developer",
    href: "/settings/developer",
    segment: "developer",
    label: "Developer",
    description: "Debug preferences and session diagnostics.",
    icon: Code2,
  },
];

export const DEFAULT_SETTINGS_ROUTE_ID: SettingsRouteId = "appearance";

export function findSettingsRouteById(
  id: string | null | undefined,
): SettingsRouteDefinition | undefined {
  return PERSONAL_SETTINGS_ROUTES.find((route) => route.id === id);
}

export function findSettingsRouteBySegment(
  segment: string | null | undefined,
): SettingsRouteDefinition | undefined {
  return PERSONAL_SETTINGS_ROUTES.find((route) => route.segment === segment);
}
