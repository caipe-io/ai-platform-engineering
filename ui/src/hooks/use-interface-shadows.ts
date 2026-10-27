"use client";

import { useSyncExternalStore } from "react";

import { INTERFACE_SHADOWS_EVENT } from "@/lib/appearance-preferences";

function readEnabled(): boolean {
  return document.documentElement.getAttribute("data-interface-shadows") === "on";
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== "caipe-shadows-enabled" && event.key !== null) return;
    document.documentElement.setAttribute("data-interface-shadows", localStorage.getItem("caipe-shadows-enabled") === "true" ? "on" : "off");
    onChange();
  };
  window.addEventListener(INTERFACE_SHADOWS_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(INTERFACE_SHADOWS_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useInterfaceShadows(): boolean {
  return useSyncExternalStore(subscribe, readEnabled, () => false);
}
