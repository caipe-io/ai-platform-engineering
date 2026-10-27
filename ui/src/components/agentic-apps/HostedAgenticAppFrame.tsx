"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, type IframeHTMLAttributes } from "react";
import { useTheme } from "@/components/theme-provider";
import { isLightColorTheme } from "@/lib/color-theme";

/** Presentation context only: never send sessions, credentials, or JWTs here. */
export const HostedAgenticAppFrame = forwardRef<HTMLIFrameElement, IframeHTMLAttributes<HTMLIFrameElement> & { appId: string }>(
  function HostedAgenticAppFrame({ appId, onLoad, ...props }, forwardedRef) {
    const frame = useRef<HTMLIFrameElement>(null);
    const readyReceived = useRef(false);
    const { resolvedTheme, systemTheme } = useTheme();
    const theme = isLightColorTheme(resolvedTheme ?? systemTheme) ? "light" : "dark";
    useImperativeHandle(forwardedRef, () => frame.current!, []);

    const publish = useCallback(() => {
      frame.current?.contentWindow?.postMessage({
        type: "caipe.microfrontend.initialize.v1", version: "1.0", appId,
        context: {
          surface: "hosted", route: window.location.pathname, theme,
          locale: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          preferences: {},
        },
      }, window.location.origin);
    }, [appId, theme]);

    useEffect(() => { publish(); }, [publish]);
    useEffect(() => {
      function onMessage(event: MessageEvent): void {
        if (readyReceived.current || !frame.current?.contentWindow ||
          event.source !== frame.current.contentWindow || event.origin !== window.location.origin) return;
        const data: unknown = event.data;
        if (!data || typeof data !== "object" || !("type" in data) || !("version" in data) || !("appId" in data) ||
          data.type !== "caipe.microfrontend.ready.v1" || data.version !== "1.0" || data.appId !== appId) return;
        // Older children acknowledge every initialize message. Reply at most
        // once per document load so those clients cannot form a message loop.
        readyReceived.current = true;
        publish();
      }
      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
    }, [appId, publish]);

    return <iframe {...props} ref={frame} onLoad={(event) => {
      readyReceived.current = false;
      publish();
      onLoad?.(event);
    }} />;
  },
);
