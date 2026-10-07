"use client";

import {
  WorkspaceNavigationList,
} from "@/components/layout/WorkspaceNavigation";
import { WorkspacePageHeader } from "@/components/layout/WorkspacePageHeader";
import { WorkspaceShell } from "@/components/layout/WorkspaceShell";
import { useRouter } from "next/navigation";
import React from "react";

import { CREDENTIALS_GROUPS } from "./navigation";
import { ProviderConnections } from "./ProviderConnections";
import { SecretsManager } from "./SecretsManager";

export type CredentialsSection = "connections" | "secrets";

export function CredentialsWorkspace({
  activeSection,
}: {
  activeSection: CredentialsSection;
}): React.ReactElement {
  const router = useRouter();

  const showConnections = React.useCallback(() => {
    router.replace("/credentials/connections");
  }, [router]);

  React.useEffect(() => {
    const handleOAuthMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== "caipe.oauth.connection") return;
      showConnections();
    };

    window.addEventListener("message",handleOAuthMessage);
    return () => window.removeEventListener("message",handleOAuthMessage);
  }, [showConnections]);

  React.useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("caipe.oauth.connection");
    const handleOAuthMessage = (event: MessageEvent) => {
      if (event.data?.type === "caipe.oauth.connection") showConnections();
    };
    channel.addEventListener("message",handleOAuthMessage);
    return () => {
      channel.removeEventListener("message",handleOAuthMessage);
      channel.close();
    };
  }, [showConnections]);

  const activeItem = CREDENTIALS_GROUPS[0].items.find((item) => item.id === activeSection)!;
  const description = activeSection === "connections"
    ? "Connect approved apps so agents can use your account access."
    : "Store protected credentials for agents and services without exposing their values.";

  return (
    <WorkspaceShell
      header={(
        <WorkspacePageHeader
          breadcrumbs={[
            { label: "Home",href: "/" },
            { label: "Credentials",href: "/credentials/connections" },
            { label: activeItem.label,href: activeItem.href },
          ]}
          description={description}
          title={activeItem.label}
        />
      )}
      navigation={(
        <WorkspaceNavigationList
          activeItemId={activeSection}
          ariaLabel="Credentials sections"
          groups={CREDENTIALS_GROUPS}
        />
      )}
      navigationAreaKey="credentials"
      navigationVersion={activeSection}
    >
      {activeSection === "connections" ? <ProviderConnections /> : <SecretsManager />}
    </WorkspaceShell>
  );
}
