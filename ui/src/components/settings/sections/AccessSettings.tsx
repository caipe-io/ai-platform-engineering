"use client";

import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/shared/SettingsCard";
import { cn } from "@/lib/utils";
import { KeyRound,Layers,Loader2,RefreshCw,Shield,Users } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback,useEffect,useState } from "react";

interface RbacPosture {
  email?: string;
  idp_source: string;
  legacy_resource_roles_hidden_count?: number;
  name?: string;
  per_agent_roles: string[];
  per_kb_roles: string[];
  realm_roles: string[];
  role: string;
  slack_linked: boolean;
  teams: Array<{ _id: string;name: string;role?: string;slug?: string }>;
  webex_link_available: boolean;
  webex_linked: boolean;
}

const WEBEX_LINK_ERROR_MESSAGES: Record<string, string> = {
  WEBEX_ID_ALREADY_LINKED: "That Webex account is already linked to a different user.",
  WEBEX_ORG_MISMATCH: "That Webex account does not belong to this organization.",
  WEBEX_PROFILE_FETCH_FAILED: "Could not read your Webex profile. Please try again.",
  TOKEN_EXCHANGE_FAILED: "Could not complete the Webex sign-in. Please try again.",
  INVALID_OAUTH_STATE: "Your Webex sign-in session expired. Please try again.",
};

function webexLinkErrorMessage(reason: string | null): string {
  if (reason && WEBEX_LINK_ERROR_MESSAGES[reason]) return WEBEX_LINK_ERROR_MESSAGES[reason];
  return "Could not link your Webex account. Please try again.";
}

export function AccessSettings(): React.ReactElement {
  const searchParams = useSearchParams();
  const [posture,setPosture] = useState<RbacPosture | null>(null);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState<string | null>(null);
  const [unlinkingWebex,setUnlinkingWebex] = useState(false);
  const [unlinkWebexError,setUnlinkWebexError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/my-roles");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load your access");
      setPosture(data as RbacPosture);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load your access");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const webexLinkStatus = searchParams.get("webex_link");
  const webexLinkReason = searchParams.get("reason");

  useEffect(() => {
    if (webexLinkStatus === "success") void load();
    // Re-check posture once after returning from the Webex OAuth grant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webexLinkStatus]);

  const unlinkWebex = useCallback(async () => {
    setUnlinkingWebex(true);
    setUnlinkWebexError(null);
    try {
      const response = await fetch("/api/auth/webex-link/unlink", { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "Could not unlink your Webex account");
      await load();
    } catch (reason) {
      setUnlinkWebexError(reason instanceof Error ? reason.message : "Could not unlink your Webex account");
    } finally {
      setUnlinkingWebex(false);
    }
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading your access…
      </div>
    );
  }

  if (error || !posture) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm">
        <p>{error || "Your access information is unavailable."}</p>
        <Button className="mt-3 gap-2" onClick={() => void load()} size="sm" variant="outline">
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {webexLinkStatus === "success" ? (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm" role="status">
          Your Webex account has been linked.
        </div>
      ) : null}
      {webexLinkStatus === "error" ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm" role="alert">
          {webexLinkErrorMessage(webexLinkReason)}
        </div>
      ) : null}
      <SettingsCard
        description="This information comes from your identity provider and platform access policy."
        title={<span className="flex items-center gap-2"><Shield className="h-5 w-5 text-primary" />Identity and role</span>}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border/70 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Platform role</p>
            <span
              className={cn(
                "mt-2 inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold",
                posture.role === "admin"
                  ? "border-primary/30 bg-primary/15 text-primary"
                  : "border-border bg-muted text-muted-foreground",
              )}
            >
              {posture.role === "admin" ? "Platform admin" : "User"}
            </span>
          </div>
          <div className="rounded-lg border border-border/70 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Connected identity</p>
            <p className="mt-2 text-sm font-medium">{posture.name || posture.email || "Signed-in user"}</p>
            {posture.email ? <p className="text-xs text-muted-foreground">{posture.email}</p> : null}
            <p className="mt-2 text-xs text-muted-foreground">
              Slack account: {posture.slack_linked ? "Linked" : "Not linked"}
            </p>
            {posture.webex_link_available ? (
              <div className="mt-2 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    Webex account: {posture.webex_linked ? "Linked" : "Not linked"}
                  </p>
                  <div className="flex items-center gap-1.5">
                    <Button
                      className="h-7 px-2 text-xs"
                      disabled={unlinkingWebex}
                      onClick={() => { window.location.href = "/api/auth/webex-link/start"; }}
                      size="sm"
                      variant="outline"
                    >
                      {posture.webex_linked ? "Relink" : "Link Webex account"}
                    </Button>
                    {posture.webex_linked ? (
                      <Button
                        className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                        disabled={unlinkingWebex}
                        onClick={() => void unlinkWebex()}
                        size="sm"
                        variant="outline"
                      >
                        {unlinkingWebex ? "Unlinking…" : "Unlink"}
                      </Button>
                    ) : null}
                  </div>
                </div>
                {unlinkWebexError ? (
                  <p className="text-xs text-destructive" role="alert">{unlinkWebexError}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        description="Teams determine which shared agents, skills, tools, and knowledge bases you can use."
        title={<span className="flex items-center gap-2"><Users className="h-5 w-5 text-primary" />Teams ({posture.teams.length})</span>}
      >
        {posture.teams.length ? (
          <div className="divide-y divide-border rounded-lg border border-border/70">
            {posture.teams.map((team) => (
              <div className="flex min-h-11 items-center justify-between gap-4 px-4 py-2" key={team.slug || team._id}>
                <span className="text-sm font-medium">{team.name}</span>
                {team.role ? (
                  <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {team.role}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">You are not currently a member of a team.</p>
        )}
      </SettingsCard>

      <SettingsCard
        description="Technical identity details can help an administrator troubleshoot unexpected access."
        title={<span className="flex items-center gap-2"><KeyRound className="h-5 w-5 text-primary" />Technical access details</span>}
      >
        <details className="rounded-lg border border-border/70 p-4">
          <summary className="cursor-pointer text-sm font-medium">Show identity-provider details</summary>
          <dl className="mt-4 space-y-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Identity provider</dt>
              <dd className="break-all font-mono text-xs">{posture.idp_source}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Realm roles</dt>
              <dd className="mt-1 flex flex-wrap gap-1.5">
                {posture.realm_roles.length ? posture.realm_roles.map((role) => (
                  <span className="rounded-md border border-primary/20 bg-primary/10 px-2 py-0.5 font-mono text-xs text-primary" key={role}>
                    {role}
                  </span>
                )) : <span className="text-xs text-muted-foreground">None</span>}
              </dd>
            </div>
            {posture.legacy_resource_roles_hidden_count ? (
              <div className="flex items-start gap-2 rounded-md bg-muted p-3 text-xs text-muted-foreground">
                <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {posture.legacy_resource_roles_hidden_count} legacy resource role(s) are hidden because current access is evaluated by policy.
              </div>
            ) : null}
          </dl>
        </details>
      </SettingsCard>
    </div>
  );
}
