"use client";

import { AuthGuard } from "@/components/auth-guard";
import { NewHomePage } from "@/components/home/NewHomePage";
import { WelcomeBanner } from "@/components/home/WelcomeBanner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useHomeWidgetsStore } from "@/store/home-widgets-store";
import { useEffect } from "react";

export default function HomePage() {
  const initialize = useHomeWidgetsStore((s) => s.initialize);

  useEffect(() => {
    initialize();
  }, [initialize]);

  return (
    <AuthGuard>
      <ScrollArea className="flex-1" data-testid="home-page">
        <div className="mx-auto max-w-6xl space-y-3 p-6 [@media(max-height:800px)]:space-y-1 [@media(max-height:800px)]:p-4 [@media(max-height:800px)]:pb-2">
          <WelcomeBanner />
          <NewHomePage />
        </div>
      </ScrollArea>
    </AuthGuard>
  );
}
