import type { WorkspaceNavigationGroup } from "@/components/layout/WorkspaceNavigation";
import { Cable,KeyRound } from "lucide-react";

export const CREDENTIALS_GROUPS: WorkspaceNavigationGroup[] = [{
  id: "credentials-sections",
  items: [
    {
      id: "connections",
      label: "Connected Apps",
      href: "/credentials/connections",
      icon: Cable,
      description: "Manage OAuth connections",
    },
    {
      id: "secrets",
      label: "Saved Secrets",
      href: "/credentials/secrets",
      icon: KeyRound,
      description: "Store protected credentials",
    },
  ],
}];
