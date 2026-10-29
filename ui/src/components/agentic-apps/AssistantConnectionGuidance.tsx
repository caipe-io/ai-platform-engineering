"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { MarkdownRenderer } from "@/components/shared/timeline/MarkdownRenderer";
import { safeConnectionAction, type AssistantConnectionGuide } from "@/lib/agentic-apps/connection-guidance";

export function ConnectionGuideButtons({ guides }: { guides: AssistantConnectionGuide[] }) {
  const [selected, setSelected] = useState<AssistantConnectionGuide | null>(null);
  return <>
    {guides.filter((guide) => guide.enabled).map((guide) => <Button key={guide.id} type="button" size="sm" variant="outline" onClick={() => setSelected(guide)}>{guide.label}</Button>)}
    <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null); }}>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{selected?.title}</DialogTitle><DialogDescription>Connection instructions for this assistant</DialogDescription></DialogHeader>
        {selected && <MarkdownRenderer content={selected.markdown} />}
        {selected?.action_url && safeConnectionAction(selected.action_url) && <Button asChild><a href={selected.action_url}>{selected.action_label}</a></Button>}
      </DialogContent>
    </Dialog>
  </>;
}

export function AssistantConnectionGuidance({ appId }: { appId: string }) {
  const [state, setState] = useState<{ appId: string; guides: AssistantConnectionGuide[] } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/agentic-apps/${encodeURIComponent(appId)}/connection-guidance`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error("Guidance unavailable"); return response.json(); })
      .then((data) => { if (!controller.signal.aborted) setState({ appId, guides: data.data?.guides ?? [] }); })
      .catch(() => { if (!controller.signal.aborted) setState({ appId, guides: [] }); });
    return () => controller.abort();
  }, [appId]);
  return <ConnectionGuideButtons guides={state?.appId === appId ? state.guides : []} />;
}
