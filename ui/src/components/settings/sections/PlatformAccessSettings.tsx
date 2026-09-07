"use client";

import { UnlinkedServiceAccountModal } from "@/components/admin/UnlinkedServiceAccountModal";
import { SettingsCard } from "@/components/settings/shared/SettingsCard";
import { Button } from "@/components/ui/button";
import { Shield } from "lucide-react";
import { useState } from "react";

export function PlatformAccessSettings({
  readOnly = false,
}: {
  readOnly?: boolean;
}): React.ReactElement {
  const [open,setOpen] = useState(false);

  return (
    <>
      <SettingsCard
        description="Set starting access for people who message CAIPE from Slack or Webex before linking their identity."
        title={<span className="flex items-center gap-2"><Shield className="h-5 w-5 text-primary" />Access before sign-in</span>}
      >
        <div className="max-w-4xl space-y-4">
          <p className="text-sm text-muted-foreground">
            Agents and tools granted here are available to every unlinked caller and bot. Review the complete grant set before applying changes.
          </p>
          <Button className="gap-2" onClick={() => setOpen(true)} type="button" variant="outline">
            <Shield className="h-4 w-4" />
            Review unlinked access
          </Button>
        </div>
      </SettingsCard>
      <UnlinkedServiceAccountModal
        isAdmin={!readOnly}
        onOpenChange={setOpen}
        open={open}
      />
    </>
  );
}
