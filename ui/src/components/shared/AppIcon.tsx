"use client";

import Image from "next/image";
import { AgenticAppIcon } from "@/components/shared/AgenticAppIcon";
import { useState } from "react";
import { resolveAgenticAppIcon } from "../../../app-sdk/agentic-app-manifest.mjs";

/** Packaged images only. Missing, invalid, or broken assets keep the app identity. */
export function AppIcon({ appId, icon, className }: { appId: string; icon?: string; className?: string }) {
  const src = resolveAgenticAppIcon(appId, icon);
  const [failedSrc, setFailedSrc] = useState<string>();
  return src && src !== failedSrc ? (
    <Image src={src} alt="" width={20} height={20} unoptimized
      className={className} aria-hidden="true" onError={() => setFailedSrc(src)} />
  ) : <AgenticAppIcon className={className} aria-hidden="true" />;
}
