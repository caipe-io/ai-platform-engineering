"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { validateAssistantOptions, type AssistantOptions, type AssistantConfiguration } from "../../../app-sdk/assistant-options.mjs";
import { Select } from "@/components/ui/select";
import type { PublicAgenticApp } from "@/types/agentic-app";
import { ASSISTANT_PRESENTATION_EVENT, readAssistantPresentation } from "@/lib/agentic-apps/assistant-presentation";

/** Full-page chat reads the same publisher options as native and iframe popups. */
export function useAppAssistantPresentation(appId: string | undefined, agentId: string) {
  const { data: session, status } = useSession();
  const key = JSON.stringify([appId, agentId, status, session?.sub, session?.user?.email, session?.org, session?.role]);
  const [loaded, setLoaded] = useState<{ key: string; app: PublicAgenticApp } | null>(null);
  const [, refresh] = useState(0);
  useEffect(() => {
    if (!appId) return;
    const update = () => refresh(value => value + 1);
    window.addEventListener("storage", update);
    window.addEventListener(ASSISTANT_PRESENTATION_EVENT, update);
    const timer = window.setInterval(update, 30000);
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener(ASSISTANT_PRESENTATION_EVENT, update);
      window.clearInterval(timer);
    };
  }, [appId]);
  useEffect(() => {
    if (!appId || status !== "authenticated") return;
    const controller = new AbortController();
    void fetch(`/api/agentic-apps/${encodeURIComponent(appId)}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`App chat presentation unavailable (${response.status})`);
        const { item }: { item: PublicAgenticApp } = await response.json();
        if (item.appId !== appId || !item.canLaunch || item.assistantAgentId !== agentId) return;
        if (item.assistantOptions) validateAssistantOptions(item.assistantOptions);
        if (!controller.signal.aborted) setLoaded({ key, app: item });
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoaded(null);
          console.warn("[App chat] Presentation unavailable", error instanceof Error ? error.message : String(error));
        }
      });
    return () => controller.abort();
  }, [key, appId, agentId, status]);
  const app = loaded?.key === key ? loaded.app : null;
  const configuration = app && appId ? readAssistantPresentation(appId, agentId, session, app.assistantOptions) : undefined;
  return { app, configuration };
}

/** Runtime configuration can narrow publisher-declared choices, never add request keys. */
export function useAssistantComposerOptions(options?: AssistantOptions, configuration?: AssistantConfiguration, scope = "") {
  const [selections, setSelections] = useState<Record<string, { signature: string; choice: string }>>({});
  const controls = (options?.requireConfiguration && !configuration ? [] : options?.controls ?? []).map(control => {
    const configured = configuration?.controls?.[control.id];
    const choices = control.choices.filter(choice => !configured || configured.choices.includes(choice.id));
    const defaultChoice = configured?.defaultChoice ?? control.defaultChoice;
    const signature = JSON.stringify([scope, choices, defaultChoice]);
    const selected = selections[control.id];
    const choice = choices.find(c => c.id === (selected?.signature === signature ? selected.choice : defaultChoice)) ?? choices[0];
    return { ...control, choices, signature, choice };
  });
  const requestOptions = Object.fromEntries(controls.filter(c => c.choice?.value !== undefined)
    .map(c => [c.requestKey, c.choice.value]));
  const composerHeader = controls.some(c => c.choices.length > 1) ? <div className="flex flex-wrap gap-2">
    {controls.filter(c => c.choices.length > 1).map(control => <label key={control.id} className="flex items-center gap-2 text-xs">
      {control.label}<Select aria-label={control.label} className="h-8 w-auto text-xs" value={control.choice.id}
        onChange={event => setSelections(previous => ({ ...previous, [control.id]: { signature: control.signature, choice: event.target.value } }))}>
        {control.choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </Select>
    </label>)}
  </div> : undefined;
  return { requestOptions, composerHeader };
}
