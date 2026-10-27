"use client";

import { useState } from "react";
import type { AssistantOptions, AssistantConfiguration } from "../../../app-sdk/assistant-options.mjs";
import { Select } from "@/components/ui/select";

/** Runtime configuration can narrow publisher-declared choices, never add request keys. */
export function useAssistantComposerOptions(options?: AssistantOptions, configuration?: AssistantConfiguration) {
  const [selections, setSelections] = useState<Record<string, { signature: string; choice: string }>>({});
  const controls = (options?.controls ?? []).map(control => {
    const configured = configuration?.controls?.[control.id];
    const choices = control.choices.filter(choice => !configured || configured.choices.includes(choice.id));
    const defaultChoice = configured?.defaultChoice ?? control.defaultChoice;
    const signature = JSON.stringify([choices, defaultChoice]);
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
