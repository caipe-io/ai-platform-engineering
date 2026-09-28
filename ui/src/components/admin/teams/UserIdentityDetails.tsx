"use client";

import type { UserIdentityInfo, UserMembershipSourceInfo } from "@/types/admin-user-identity";

export function UserIdentityDetails({ userId, principalType = "user", identity, loading, error, onRetry }: {
  userId: string;
  principalType?: "user" | "service_account";
  identity: UserIdentityInfo | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const unavailable = identity?.unavailable ?? [];
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">CAIPE identity</h4>
        <button type="button" className="text-xs underline disabled:opacity-50" disabled={loading} onClick={onRetry}>
          {loading ? "Loading identity…" : "Refresh identity"}
        </button>
      </div>
      <dl className="grid gap-3 sm:grid-cols-2 text-sm">
        <div><dt className="text-muted-foreground">Account type</dt><dd>{principalType === "service_account" ? "Service account" : "Human user"}</dd></div>
        <div><dt className="text-muted-foreground">Keycloak user ID</dt><dd className="font-mono break-all select-all">{userId}</dd></div>
        <div><dt className="text-muted-foreground">Expected OpenFGA principal</dt><dd className="font-mono break-all select-all">{principalType}:{userId}</dd></div>
        <div><dt className="text-muted-foreground">Keycloak realm</dt><dd>{loading ? "Loading…" : identity?.realm || "Unavailable"}</dd></div>
      </dl>
      <p className="text-xs text-muted-foreground">Email is a lookup/display attribute, not the canonical user ID. The principal above is the expected key, not proof that grants exist under it.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!loading && identity && <>
        <div>
          <h4 className="text-sm font-medium">Linked upstream accounts</h4>
          <p className="mt-1 text-xs text-muted-foreground">These external accounts are linked to the Keycloak user above. Provider claim-mapping rules and original upstream claim values are not inspected in this view.</p>
          {unavailable.includes("federatedIdentities") ? <p className="text-sm text-destructive">Linked accounts unavailable. This does not mean the account is local.</p>
            : identity.federatedIdentities.length === 0 ? <p className="text-sm text-muted-foreground">No broker-linked accounts reported by Keycloak.</p>
            : <ul className="mt-2 space-y-2">{identity.federatedIdentities.map((link) => (
              <li key={`${link.identityProvider}:${link.userId}`} className="rounded-lg border border-border p-3 text-sm break-all">
                <p className="font-medium">{link.identityProvider}</p>
                <p>External ID: <span className="font-mono select-all">{link.userId || "Not reported"}</span></p>
                <p className="text-muted-foreground">Upstream username: {link.userName || "Not reported"}</p>
              </li>
            ))}</ul>}
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">Keycloak direct realm-role mappings</summary>
          <p className="mt-2 break-words">{unavailable.includes("realmRoles") ? "Role mappings unavailable." : identity.realmRoles?.join(", ") || "No direct realm-role mappings."}</p>
          <p className="mt-1 text-xs text-muted-foreground">Not a complete effective-role list or CAIPE resource permissions. Inherited roles, client roles and token scopes are not inspected here.</p>
        </details>
        <p className="text-xs text-muted-foreground">Keycloak queried at {identity.fetchedAt || "unknown time"}. Linked accounts do not expose all upstream claims, scopes or entitlements.</p>
      </>}

    </div>
  );
}

export function UserMembershipSources({ userId, sources, sourcesAvailable }: {
  userId: string;
  sources?: UserMembershipSourceInfo[];
  sourcesAvailable?: boolean;
}) {
  return (
      <div className="text-sm space-y-2">
        <h4 className="font-medium">Active membership sources{sourcesAvailable ? ` (${sources?.length ?? 0})` : ""}</h4>
        <p className="mt-2 text-xs text-muted-foreground">CAIPE membership records matched by this account’s email, not a live upstream directory query or proof of OpenFGA synchronization.</p>
        {!sourcesAvailable ? <p className="mt-2">Membership source information unavailable.</p>
          : !sources?.length ? <p className="mt-2">No active membership sources recorded.</p>
          : <ul className="mt-2 space-y-2">{sources.map((source, index) => (
            <li key={`${source.team}:${source.source}:${index}`} className="rounded-lg border border-border p-3 break-words">
              <p className="font-medium">{source.team} · {source.relationship} · {source.source}</p>
              {source.provider && <p>Provider: {source.provider}</p>}
              {source.externalGroup && <p>External group: {source.externalGroup}</p>}
              <p className="font-mono text-xs break-all">Recorded subject: {source.subject || "Unresolved"}</p>
              {source.subject !== userId && <p className="text-destructive">{source.subject ? "Recorded subject differs from this Keycloak user. Review the identity link." : "Identity link is unresolved."}</p>}
              <p className="text-xs text-muted-foreground">Last observed: {source.lastSeenAt || "Not recorded"} · Last applied: {source.lastAppliedAt || "Not recorded"}</p>
            </li>
          ))}</ul>}
      </div>
  );
}
