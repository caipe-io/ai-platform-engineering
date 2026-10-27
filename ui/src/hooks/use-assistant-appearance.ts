"use client";

import { useSyncExternalStore } from "react";

import { ASSISTANT_APPEARANCE_EVENT, isAssistantFontScale } from "@/lib/appearance-preferences";

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === "agentic-app-assistant-glass" || event.key === "agentic-app-assistant-font-scale") onChange();
  };
  window.addEventListener(ASSISTANT_APPEARANCE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(ASSISTANT_APPEARANCE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function readGlass(): boolean { return localStorage.getItem("agentic-app-assistant-glass") !== "false"; }
function readScale() {
  const value = localStorage.getItem("agentic-app-assistant-font-scale");
  return isAssistantFontScale(value) ? value : "auto";
}

export function useAssistantAppearance(appDefault: "compact" | "default" | "large" = "compact") {
  const glassMode = useSyncExternalStore(subscribe, readGlass, () => true);
  const savedScale = useSyncExternalStore(subscribe, readScale, () => "auto");
  return { glassMode, fontScale: savedScale === "auto" ? appDefault : savedScale };
}
