"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function RunFollowUpButton({ runId, conversationId, openChat }: {
  runId: string;
  conversationId?: string;
  openChat: (runId: string) => Promise<string>;
}) {
  const router = useRouter();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    if (opening) return;
    setOpening(true);
    setError(null);
    try {
      const id = await openChat(runId);
      router.push(`/chat/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the follow-up chat.");
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="mt-2 space-y-1">
      {conversationId ? (
        <Button asChild variant="outline" size="sm">
          <Link href={`/chat/${conversationId}`}>Open manual follow-up</Link>
        </Button>
      ) : (
        <Button type="button" variant="outline" size="sm" disabled={opening} onClick={() => void open()}>
          {opening ? "Preparing chat…" : "Continue this run"}
        </Button>
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
