"use client";

import { MessageCircle, X } from "lucide-react";
import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MarkdownRenderer } from "@/components/shared/timeline/MarkdownRenderer";
import { safeConnectionAction, type AssistantConnectionGuide } from "@/lib/agentic-apps/connection-guidance";

export function ConnectionGuideButtons({ guides }: { guides: AssistantConnectionGuide[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const instanceId = useId();
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const activeGuide = guides.find((guide) => guide.enabled && guide.id === selectedId);

  useEffect(() => {
    if (!activeGuide) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setSelectedId(null);
      triggerRefs.current[activeGuide.id]?.focus();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeGuide]);

  return <>
    {guides.filter((guide) => guide.enabled).map((guide) => {
      const open = selectedId === guide.id;
      const titleId = `${instanceId}-${guide.id}-title`;
      const panelId = `${instanceId}-${guide.id}-panel`;
      const identity = `${guide.id} ${guide.label}`;
      const logo = /\bwebex\b/i.test(identity) ? "/provider-logos/webex.svg" : /\bslack\b/i.test(identity) ? "/slack.svg" : null;
      return <Popover key={guide.id} open={open} onOpenChange={(next) => { if (next) setSelectedId(guide.id); }}>
        <PopoverTrigger asChild>
          <Button ref={(node) => { triggerRefs.current[guide.id] = node; }} type="button" size="icon" variant="outline"
            className="h-8 w-8" aria-label={guide.label} title={guide.label} aria-haspopup="dialog"
            aria-expanded={open} aria-controls={open ? panelId : undefined}>
            {logo ? <Image src={logo} width={20} height={20} alt="" unoptimized className="h-5 w-5 object-contain" /> : <MessageCircle className="h-5 w-5" aria-hidden />}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="max-h-[70vh] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto p-4">
          <div id={panelId} role="dialog" aria-labelledby={titleId} className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <h3 id={titleId} className="text-sm font-semibold">{guide.title}</h3>
              <Button type="button" variant="ghost" size="icon" className="-mr-2 -mt-2 h-8 w-8 shrink-0"
                aria-label="Close connection instructions" onClick={() => { setSelectedId(null); triggerRefs.current[guide.id]?.focus(); }}>
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <MarkdownRenderer content={guide.markdown} />
            {guide.action_url && safeConnectionAction(guide.action_url) && <Button asChild><a href={guide.action_url}>{guide.action_label}</a></Button>}
          </div>
        </PopoverContent>
      </Popover>;
    })}
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
