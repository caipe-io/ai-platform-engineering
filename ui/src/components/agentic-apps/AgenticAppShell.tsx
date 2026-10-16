"use client";

import { ArrowLeft, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { WorkspaceBreadcrumbs } from "@/components/layout/WorkspacePageHeader";
import { buildAgenticAppPublicPath } from "@/lib/agentic-apps/runtime";
import { nativeAgenticAppDestination } from "@/lib/agentic-apps/public-app";
import type { PublicAgenticApp } from "@/types/agentic-app";

type ShellState =
  | { status: "loading" }
  | { status: "ready"; app: PublicAgenticApp }
  | { status: "error"; title: string; message: string };

export function AgenticAppShell({
  appId,
  path,
}: {
  appId: string;
  path: string[];
}): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [state, setState] = useState<ShellState>({ status: "loading" });
  const aliasPath = JSON.stringify(path);
  const search = searchParams.toString();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/agentic-apps/${encodeURIComponent(appId)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        if (response.status === 401) {
          router.push(
            `/login?callbackUrl=${encodeURIComponent(window.location.pathname + window.location.search)}`,
          );
          return null;
        }
        if (!response.ok)
          throw new Error(`App lookup returned HTTP ${response.status}`);
        return response.json() as Promise<{ item: PublicAgenticApp }>;
      })
      .then((payload) => {
        if (cancelled || !payload) return;
        const app = payload.item;
        if (!app) {
          setState({
            status: "error",
            title: "App not found",
            message: "This App is not installed.",
          });
        } else if (!app.canLaunch) {
          setState({
            status: "error",
            title: "Access required",
            message: `You do not have permission to open ${app.displayName}.`,
          });
        } else if (app.uiMode === "native-package") {
          router.replace(
            nativeAgenticAppDestination(app, JSON.parse(aliasPath), search),
          );
        } else {
          setState({ status: "ready", app });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            title: "Could not open App",
            message:
              error instanceof Error ? error.message : "Unexpected error",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [aliasPath, appId, router, search]);

  if (state.status === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center">
        <LoaderCircle
          className="h-6 w-6 animate-spin text-muted-foreground"
          aria-label="Loading App"
        />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-lg rounded-xl border p-8 text-center">
          <h1 className="text-xl font-semibold">{state.title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
          <Link
            className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-primary"
            href="/apps"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden /> Back to Apps
          </Link>
        </div>
      </div>
    );
  }

  const query = searchParams.toString();
  const runtimePath = `${buildAgenticAppPublicPath(appId, path)}${query ? `?${query}` : ""}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WorkspaceBreadcrumbs
        breadcrumbs={[
          { label: "Home", href: "/" },
          { label: "Apps", href: "/apps" },
          { label: state.app.displayName },
        ]}
      />
      <iframe
        className="min-h-0 flex-1 border-0 bg-background"
        src={runtimePath}
        title={state.app.displayName}
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}
