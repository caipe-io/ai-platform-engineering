"use client";

import { FeaturePreferences } from "@/components/settings/FeaturePreferences";
import { SettingsCard } from "@/components/settings/shared/SettingsCard";
import { Button } from "@/components/ui/button";
import { config } from "@/lib/config";
import { cn } from "@/lib/utils";
import { Bug,Check,Clock,Code2,Copy,RefreshCw,Users } from "lucide-react";
import { useSession } from "next-auth/react";
import { useMemo,useState } from "react";

function decodeJwtPayload(token: string | undefined): Record<string,unknown> | null {
  if (!token) return null;
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return null;
    const normalized = encoded.replace(/-/g,"+").replace(/_/g,"/");
    return JSON.parse(decodeURIComponent(atob(normalized).split("").map((character) => {
      return `%${(`00${character.charCodeAt(0).toString(16)}`).slice(-2)}`;
    }).join(""))) as Record<string,unknown>;
  } catch {
    return null;
  }
}

function secondsRemaining(expiresAt?: number): string {
  if (!expiresAt) return "Not provided";
  const remaining = expiresAt - Math.floor(Date.now() / 1000);
  if (remaining <= 0) return "Expired";
  const days = Math.floor(remaining / 86400);
  const hours = Math.floor((remaining % 86400) / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  return days > 0 ? `${days}d ${hours}h remaining` : `${hours}h ${minutes}m remaining`;
}

function DetailRow({ label,value }: { label: string;value: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/40 py-2 last:border-0">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="break-all text-right font-mono text-xs">{value}</dd>
    </div>
  );
}

export function DeveloperSettings(): React.ReactElement {
  const { data: session,update } = useSession();
  const [refreshing,setRefreshing] = useState(false);
  const [refreshResult,setRefreshResult] = useState<"success" | "error" | null>(null);
  const [copied,setCopied] = useState(false);
  const decoded = useMemo(() => decodeJwtPayload(session?.accessToken),[session?.accessToken]);
  const groups = useMemo(() => {
    if (!decoded) return [];
    const result = new Set<string>();
    for (const claim of ["members","memberOf","groups","group","roles","cognito:groups"]) {
      const value = decoded[claim];
      if (Array.isArray(value)) value.forEach((item) => result.add(String(item)));
      if (typeof value === "string") value.split(/[,\s]+/).filter(Boolean).forEach((item) => result.add(item));
    }
    return [...result];
  }, [decoded]);

  const refresh = async () => {
    setRefreshing(true);
    setRefreshResult(null);
    try {
      const refreshed = await update();
      setRefreshResult(refreshed ? "success" : "error");
    } catch (error) {
      console.error("[DeveloperSettings] Token refresh failed",error);
      setRefreshResult("error");
    } finally {
      setRefreshing(false);
    }
  };

  const copyToken = async () => {
    if (!session?.accessToken) return;
    try {
      await navigator.clipboard.writeText(session.accessToken);
      setCopied(true);
      window.setTimeout(() => setCopied(false),2000);
    } catch (error) {
      console.error("[DeveloperSettings] Access token copy failed",error);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsCard
        description="Enable additional browser logging while troubleshooting agent interactions."
        title={<span className="flex items-center gap-2"><Bug className="h-5 w-5 text-primary" />Debug preference</span>}
      >
        <FeaturePreferences ids={["debug"]} />
      </SettingsCard>

      <SettingsCard
        description="Review token lifetime and refresh the current session without signing out."
        title={<span className="flex items-center gap-2"><Clock className="h-5 w-5 text-primary" />OIDC session</span>}
      >
        <div className="space-y-4">
          <dl className="rounded-lg border border-border/70 px-4">
            <DetailRow
              label="Access token"
              value={session?.expiresAt
                ? `${new Date(session.expiresAt * 1000).toLocaleString()} (${secondsRemaining(session.expiresAt)})`
                : "Expiry not provided"}
            />
            <DetailRow label="Refresh token" value={session?.hasRefreshToken ? "Available" : "Unavailable"} />
            {session?.refreshTokenExpiresAt ? (
              <DetailRow label="Refresh token lifetime" value={secondsRemaining(session.refreshTokenExpiresAt)} />
            ) : null}
            <DetailRow label="Session status" value={session?.error || "Healthy"} />
          </dl>

          {session?.hasRefreshToken ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button className="gap-2" disabled={refreshing} onClick={() => void refresh()} size="sm">
                <RefreshCw className={cn("h-3.5 w-3.5",refreshing && "animate-spin")} />
                {refreshing ? "Refreshing…" : "Refresh access token"}
              </Button>
              {refreshResult === "success" ? <span className="text-xs text-emerald-600">Token refreshed</span> : null}
              {refreshResult === "error" ? <span className="text-xs text-destructive">Token refresh failed</span> : null}
            </div>
          ) : null}

          {session?.accessToken ? (
            <details className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
              <summary className="cursor-pointer text-sm font-medium">Sensitive token tools</summary>
              <p className="mt-3 text-xs text-muted-foreground">
                Access tokens grant your current permissions. Copy one only for a trusted local diagnostic workflow and never share it in tickets or chat.
              </p>
              <Button className="mt-3 gap-2" onClick={() => void copyToken()} size="sm" variant="outline">
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy access token"}
              </Button>
            </details>
          ) : null}
        </div>
      </SettingsCard>

      {groups.length ? (
        <SettingsCard
          description="Groups found in common OIDC access-token claims."
          title={<span className="flex items-center gap-2"><Users className="h-5 w-5 text-primary" />OIDC groups ({groups.length})</span>}
        >
          <div className="flex flex-wrap gap-2">
            {groups.map((group) => (
              <span className="rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs" key={group}>{group}</span>
            ))}
          </div>
        </SettingsCard>
      ) : null}

      <SettingsCard
        description="Read-only values useful when reporting an environment-specific issue."
        title={<span className="flex items-center gap-2"><Code2 className="h-5 w-5 text-primary" />Runtime diagnostics</span>}
      >
        <details className="rounded-lg border border-border/70 p-4">
          <summary className="cursor-pointer text-sm font-medium">Show runtime details</summary>
          <dl className="mt-4 rounded-lg bg-muted/30 px-4">
            <DetailRow label="Signed-in email" value={session?.user?.email || "Unavailable"} />
            <DetailRow label="Role" value={session?.role || "user"} />
            <DetailRow label="Authorized" value={String(session?.isAuthorized ?? false)} />
            <DetailRow label="App" value={config.appName} />
            <DetailRow label="Environment" value={config.isDev ? "development" : config.isProd ? "production" : "unknown"} />
            <DetailRow label="SSO enabled" value={String(config.ssoEnabled)} />
            <DetailRow label="MongoDB enabled" value={String(config.mongodbEnabled)} />
            <DetailRow label="Storage mode" value={config.storageMode} />
          </dl>
        </details>
      </SettingsCard>
    </div>
  );
}
