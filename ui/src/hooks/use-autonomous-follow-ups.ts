"use client";

import { useCallback, useEffect, useState } from "react";
import { autonomousApi } from "@/components/autonomous/api";

export function useAutonomousFollowUps(taskId?: string) {
  const [state, setState] = useState<{ taskId: string; links: Record<string, string> } | null>(null);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    void autonomousApi.listFollowUpChats(taskId).then((links) => {
      if (!cancelled) setState({ taskId, links });
    }).catch((error) => {
      // Opening a run still resolves its existing branch on the server.
      console.warn("Could not load autonomous follow-up links:", error);
    });
    return () => { cancelled = true; };
  }, [taskId]);

  const openChat = useCallback(async (runId: string) => {
    if (!taskId) throw new Error("This run has no task identifier.");
    const result = await autonomousApi.openFollowUpChat(taskId, runId);
    setState((previous) => ({
      taskId,
      links: { ...(previous?.taskId === taskId ? previous.links : {}), [runId]: result.conversation_id },
    }));
    return result.conversation_id;
  }, [taskId]);

  return { links: state?.taskId === taskId ? state?.links ?? {} : {}, openChat };
}
