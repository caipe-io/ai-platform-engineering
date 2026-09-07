import { FeaturePreferences } from "@/components/settings/FeaturePreferences";
import { UserDefaultAgentsPanel } from "@/components/settings/DefaultAgents/UserDefaultAgentsPanel";
import { SettingsCard } from "@/components/settings/shared/SettingsCard";
import { Bot,MessageSquare } from "lucide-react";

export function ChatSettings(): React.ReactElement {
  return (
    <div className="space-y-6">
      <SettingsCard
        description="Choose which agent opens a new conversation on each connected surface. Changes save independently."
        title={<span className="flex items-center gap-2"><Bot className="h-5 w-5 text-primary" />Default agents</span>}
      >
        <UserDefaultAgentsPanel />
      </SettingsCard>

      <SettingsCard
        description="Control what the chat interface remembers and shows."
        title={<span className="flex items-center gap-2"><MessageSquare className="h-5 w-5 text-primary" />Conversation behavior</span>}
      >
        <FeaturePreferences categories={["ai","chat"]} />
      </SettingsCard>
    </div>
  );
}
