"use client";

import { useSyncExternalStore } from "react";

import { ASSISTANT_APPEARANCE_EVENT, isAssistantFontScale } from "@/lib/appearance-preferences";

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === "agentic-app-assistant-font-scale") onChange();
  };
  window.addEventListener(ASSISTANT_APPEARANCE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(ASSISTANT_APPEARANCE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function readScale() {
  const value = localStorage.getItem("agentic-app-assistant-font-scale");
  return isAssistantFontScale(value) ? value : "auto";
}

export function useAssistantAppearance(appDefault: "compact" | "default" | "large" = "compact") {
  const savedScale = useSyncExternalStore(subscribe, readScale, () => "auto");
  return { fontScale: savedScale === "auto" ? appDefault : savedScale };
}
