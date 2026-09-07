"use client";

// assisted-by Codex Codex-sonnet-4-6

import React from "react";

import {
  describeProviderConnectionHealth,
  formatExpiresInLabel,
  formatRelativeRefreshLabel,
  supportsProfileCheck,
} from "@/lib/credentials/provider-connection-display";

interface ProviderConnection {
  id: string;
  connectorId?: string;
  provider: string;
  status: string;
  updatedAt?: string | Date;
  connectedAt?: string | Date;
  expiresAt?: string | Date;
  // False ⇒ no refresh token; connection is valid now but will expire and
  // need manual re-auth. Absent on legacy connections ⇒ assume renewable.
  renewable?: boolean;
  profileSummary?: string;
  requestedScopes?: string[];
  grantedScopes?: string[];
  owner?: {
    email?: string;
    name?: string;
    displayName?: string;
  };
}

interface OAuthConnector {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  scopes?: string[];
}

interface ProviderProfileCheckResult {
  ok: boolean;
  provider: string;
  status?: number;
  profile?: Record<string, unknown>;
  profile_check?: {
    ok: boolean;
    status?: number;
    message?: string;
  };
  accessible_resources?: Array<Record<string, unknown>>;
  diagnostics?: TokenDiagnostic[];
  next_action?: string;
  message?: string;
}

interface TokenDiagnostic {
  id: string;
  label: string;
  status: "passed" | "warning" | "failed";
  detail: string;
  action: string;
  http_status?: number;
}

interface ProviderConnectionRefreshResult {
  id: string;
  provider: string;
  ok: boolean;
  expires_in?: number;
}

interface ProfileCheckState {
  loading: boolean;
  result?: ProviderProfileCheckResult;
  error?: string;
}

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

function oauthPopupFeatures(): string {
  return [
    "popup=yes",
    "width=640",
    "height=760",
    "resizable=yes",
    "scrollbars=yes",
  ].join(",");
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const json = (await response.json()) as { data: T };
  return json.data;
}

/**
 * Effective per-user scope selection for a connector row, bounded to (and
 * ordered by) the connector's allowed scopes. Precedence: an in-session
 * override (user toggled) ⟶ the connection's stored requestedScopes ⟶ the full
 * allowed set. Intersecting with the allowed set naturally drops any stored
 * scope the connector no longer offers.
 */
function effectiveScopeSelection(
  connector: OAuthConnector,
  connection: ProviderConnection | null,
  override?: string[],
): string[] {
  const allowed = connector.scopes ?? [];
  const base = override ?? connection?.requestedScopes ?? allowed;
  return allowed.filter((scope) => base.includes(scope));
}

export function ProviderConnections() {
  const [connections, setConnections] = React.useState<ProviderConnection[]>([]);
  const [connectors, setConnectors] = React.useState<OAuthConnector[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [profileChecks, setProfileChecks] = React.useState<Record<string, ProfileCheckState>>({});
  const [autoRefreshStates, setAutoRefreshStates] = React.useState<Record<string, { loading: boolean; error?: string }>>({});
  const [expandedAdvanced, setExpandedAdvanced] = React.useState<Record<string, boolean>>({});
  // In-session scope overrides keyed by connector id; set only when the user
  // toggles a checkbox. Absent ⇒ derive from the stored/default selection.
  const [scopeOverrides, setScopeOverrides] = React.useState<Record<string, string[]>>({});
  const [revokingConnections, setRevokingConnections] = React.useState<Record<string, boolean>>({});
  const [diagnosticModal, setDiagnosticModal] = React.useState<{
    connector: OAuthConnector;
    connection: ProviderConnection;
    connectorName: string;
    result: ProviderProfileCheckResult;
  } | null>(null);
  const autoRefreshAttempted = React.useRef<Set<string>>(new Set());

  const load = React.useCallback(async () => {
    try {
      const [connectionsResponse, connectorsResponse] = await Promise.all([
        fetch("/api/credentials/connections"),
        fetch("/api/credentials/oauth-connectors"),
      ]);
      if (!connectionsResponse.ok || !connectorsResponse.ok) {
        throw new Error("Could not load provider connections");
      }
      const nextConnections = await parseApiResponse<ProviderConnection[]>(connectionsResponse);
      const nextConnectors = await parseApiResponse<OAuthConnector[]>(connectorsResponse);
      setConnections(nextConnections);
      setConnectors((current) => {
        if (nextConnectors.length === 0 && current.length > 0) {
          return current;
        }
        return nextConnectors;
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load provider connections");
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    const handleOAuthMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== "caipe.oauth.connection") return;
      void load();
    };

    window.addEventListener("message", handleOAuthMessage);
    return () => window.removeEventListener("message", handleOAuthMessage);
  }, [load]);

  React.useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("caipe.oauth.connection");
    channel.addEventListener("message", (event) => {
      if (event.data?.type === "caipe.oauth.connection") {
        void load();
      }
    });
    return () => channel.close();
  }, [load]);

  const handleProfileCheck = async (connector: OAuthConnector, connection: ProviderConnection) => {
    setProfileChecks((current) => ({
      ...current,
      [connection.id]: { loading: true },
    }));

    try {
      const response = await fetch(`/api/credentials/connections/${connection.id}/profile`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error("Profile check failed");
      }
      const result = await parseApiResponse<ProviderProfileCheckResult>(response);
      setProfileChecks((current) => ({
        ...current,
        [connection.id]: { loading: false, result },
      }));
      setDiagnosticModal({
        connector,
        connection,
        connectorName: profileProviderLabel(connector.provider, connector.name),
        result,
      });
    } catch (err) {
      setProfileChecks((current) => ({
        ...current,
        [connection.id]: {
          loading: false,
          error:
            err instanceof Error
              ? err.message
              : `${connector.name} connection test failed`,
        },
      }));
    }
  };

  const refreshConnection = React.useCallback(async (connection: ProviderConnection) => {
    setAutoRefreshStates((current) => ({
      ...current,
      [connection.id]: { loading: true },
    }));

    try {
      const response = await fetch(`/api/credentials/connections/${connection.id}/refresh`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error("Automatic refresh failed");
      }
      const result = await parseApiResponse<ProviderConnectionRefreshResult>(response);
      const refreshedAt = new Date();
      setConnections((current) =>
        current.map((candidate) =>
          candidate.id === connection.id
            ? {
                ...candidate,
                status: "connected",
                updatedAt: refreshedAt,
                expiresAt:
                  typeof result.expires_in === "number"
                    ? new Date(refreshedAt.getTime() + result.expires_in * 1000)
                    : candidate.expiresAt,
              }
            : candidate,
        ),
      );
      setAutoRefreshStates((current) => ({
        ...current,
        [connection.id]: { loading: false },
      }));
    } catch (err) {
      setAutoRefreshStates((current) => ({
        ...current,
        [connection.id]: {
          loading: false,
          error: err instanceof Error ? err.message : "Automatic refresh failed",
        },
      }));
    }
  }, []);

  const handleClearConnection = React.useCallback(
    async (connection: ProviderConnection, providerLabel: string) => {
      setRevokingConnections((current) => ({ ...current, [connection.id]: true }));
      try {
        const response = await fetch(`/api/credentials/connections/${connection.id}`, {
          method: "DELETE",
        });
        if (!response.ok) {
          throw new Error(`Could not clear ${providerLabel} connection`);
        }
        setProfileChecks((current) => {
          const next = { ...current };
          delete next[connection.id];
          return next;
        });
        setAutoRefreshStates((current) => {
          const next = { ...current };
          delete next[connection.id];
          return next;
        });
        autoRefreshAttempted.current.delete(connection.id);
        await load();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : `Could not clear ${providerLabel} connection`,
        );
      } finally {
        setRevokingConnections((current) => {
          const next = { ...current };
          delete next[connection.id];
          return next;
        });
      }
    },
    [load],
  );

  const handleOAuthConnect = React.useCallback(
    (
      event: React.MouseEvent<HTMLAnchorElement>,
      connector: OAuthConnector,
      options?: { scopes?: string[]; sendScopes?: boolean },
    ) => {
      event.preventDefault();
      let url = `/api/credentials/oauth/${connector.provider}/connect`;
      // Only send an explicit scope selection when the user customized it (or
      // we are preserving a prior custom choice on relink). Otherwise omit the
      // param so the connector default is used (legacy behavior).
      if (options?.sendScopes && options.scopes && options.scopes.length > 0) {
        url += `?scopes=${encodeURIComponent(options.scopes.join(","))}`;
      }
      const popup = window.open(url, `caipe-oauth-${connector.provider}`, oauthPopupFeatures());
      if (popup) {
        popup.focus?.();
      }
    },
    [],
  );

  const connectionForConnector = React.useMemo(() => {
    const byKey = new Map<string, ProviderConnection>();
    const sorted = [...connections].sort((left, right) => {
      const leftTime = new Date(left.updatedAt ?? left.connectedAt ?? 0).getTime();
      const rightTime = new Date(right.updatedAt ?? right.connectedAt ?? 0).getTime();
      return rightTime - leftTime;
    });
    for (const connection of sorted) {
      if (connection.connectorId && !byKey.has(`id:${connection.connectorId}`)) {
        byKey.set(`id:${connection.connectorId}`, connection);
      }
      if (!byKey.has(`provider:${connection.provider}`)) {
        byKey.set(`provider:${connection.provider}`, connection);
      }
    }
    return byKey;
  }, [connections]);

  const connectionRows = React.useMemo(
    () =>
      connectors.map((connector) => ({
        connector,
        connection:
          connectionForConnector.get(`id:${connector.id}`) ??
          connectionForConnector.get(`provider:${connector.provider}`) ??
          null,
      })),
    [connectors, connectionForConnector],
  );

  React.useEffect(() => {
    for (const { connection } of connectionRows) {
      if (!connection || !needsAutoRefresh(connection)) continue;
      if (autoRefreshAttempted.current.has(connection.id)) continue;
      autoRefreshAttempted.current.add(connection.id);
      void refreshConnection(connection);
    }
  }, [connectionRows, refreshConnection]);

  return (
    <section className="space-y-4">
      <p className="text-xs text-muted-foreground/70">
        Adding additional apps requires admin permissions.
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="overflow-hidden rounded-xl border border-border bg-card/80 shadow-sm">
        {connectionRows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] table-fixed text-left">
              <thead className="bg-gradient-to-r from-muted/55 via-muted/35 to-muted/55 text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
                <tr>
                  <th className="w-[24%] px-5 py-4 font-semibold">Provider</th>
                  <th className="w-[14%] px-4 py-4 font-semibold">Connection health</th>
                  <th className="w-[18%] px-4 py-4 font-semibold">Last successful</th>
                  <th className="w-[16%] px-4 py-4 font-semibold">Last refresh</th>
                  <th className="w-[10%] px-4 py-4 font-semibold">Status</th>
                  <th className="w-[18%] px-5 py-4 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {connectionRows.map(({ connector, connection }) => {
                  const connected = Boolean(connection);
                  const tokenHealth = describeProviderConnectionHealth(connection);
                  const profileCheck = connection ? profileChecks[connection.id] : undefined;
                  const autoRefreshState = connection ? autoRefreshStates[connection.id] : undefined;
                  const profileLabel = profileProviderLabel(connector.provider, connector.name);
                  const allowedScopes = connector.scopes ?? [];
                  const selectedScopes = effectiveScopeSelection(connector, connection, scopeOverrides[connector.id]);
                  // Send an explicit selection when the user customized it, or
                  // to preserve a prior custom narrowing on relink.
                  const hasCustomSelection =
                    Boolean(scopeOverrides[connector.id]) || Boolean(connection?.requestedScopes);
                  const selectionEmpty = allowedScopes.length > 0 && selectedScopes.length === 0;
                  const advancedOpen = Boolean(expandedAdvanced[connector.id]);
                  const toggleScope = (scope: string) => {
                    setScopeOverrides((current) => {
                      const next = current[connector.id]
                        ? [...current[connector.id]]
                        : [...selectedScopes];
                      const index = next.indexOf(scope);
                      if (index >= 0) {
                        next.splice(index, 1);
                      } else {
                        next.push(scope);
                      }
                      return { ...current, [connector.id]: next };
                    });
                  };
                  return (
                    <React.Fragment key={connector.id}>
                    <tr className="bg-card/45 transition-colors hover:bg-muted/25">
                      <td className="px-5 py-5 align-middle">
                        <div className="flex min-w-0 items-center gap-3">
                          <span
                            className={cx(
                              "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-sm font-bold text-white shadow-lg ring-1 ring-white/10",
                              providerAccentClasses(connector.provider),
                            )}
                            role="img"
                            aria-label={`${profileLabel} logo`}
                          >
                            <ProviderLogo provider={connector.provider} />
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-foreground">{connector.name}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {connection?.profileSummary?.trim() ||
                                connection?.owner?.email?.trim() ||
                                connector.provider}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-5 align-middle">
                        <StatusPill tone={healthTone(tokenHealth)}>{tokenHealth}</StatusPill>
                      </td>
                      <td className="px-4 py-5 align-middle text-sm text-muted-foreground/90">
                        {connected ? formatDateTime(connection?.connectedAt ?? connection?.updatedAt) : "Never connected"}
                      </td>
                      <td className="px-4 py-5 align-middle">
                        <div className="space-y-1">
                          <p className="text-sm font-semibold text-foreground">
                            {autoRefreshState?.loading
                              ? "refreshing"
                              : connected
                                ? connection?.status ?? "unknown"
                                : "No refresh yet"}
                          </p>
                          {connected && (
                            <p className="text-xs text-muted-foreground/80">
                              {connection?.renewable === false
                                ? formatExpiresInLabel(connection?.expiresAt) ??
                                  "manual reconnect at expiry"
                                : formatRelativeRefreshLabel(connection?.updatedAt ?? connection?.connectedAt) ??
                                  formatDateTime(connection?.updatedAt)}
                            </p>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-5 align-middle">
                        <div className="flex items-center gap-2">
                          <ConnectionStatusMark connection={connection} providerLabel={profileLabel} />
                          {connection && supportsProfileCheck(connector.provider) && (
                            <button
                              type="button"
                              className={cx(
                                "inline-flex h-8 w-8 items-center justify-center rounded-full border shadow-sm ring-1 ring-white/[0.04] transition hover:scale-105 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100",
                                profileCheck?.result?.ok
                                  ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-700 hover:bg-emerald-400/20 dark:text-emerald-300"
                                  : profileCheck?.result || profileCheck?.error
                                    ? "border-amber-400/40 bg-amber-400/10 text-amber-700 hover:bg-amber-400/20 dark:text-amber-300"
                                    : "border-cyan-400/40 bg-cyan-400/10 text-cyan-700 hover:bg-cyan-400/20 dark:text-cyan-200",
                              )}
                              disabled={Boolean(profileCheck?.loading)}
                              aria-label={
                                profileCheck?.result
                                  ? `View ${profileLabel} connection details`
                                  : `Test ${profileLabel} connection`
                              }
                              title={
                                profileCheck?.result
                                  ? `View ${profileLabel} connection details`
                                  : `Test ${profileLabel} connection`
                              }
                              onClick={() => {
                                if (profileCheck?.result) {
                                  setDiagnosticModal({
                                    connector,
                                    connection,
                                    connectorName: profileLabel,
                                    result: profileCheck.result,
                                  });
                                  return;
                                }
                                void handleProfileCheck(connector, connection);
                              }}
                            >
                              {profileCheck?.loading ? (
                                <SpinnerIcon />
                              ) : profileCheck?.result?.ok ? (
                                <CheckCircleIcon />
                              ) : profileCheck?.result || profileCheck?.error ? (
                                <AlertCircleIcon />
                              ) : (
                                <LinkTestIcon />
                              )}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-5 align-middle">
                        <div className="flex flex-col items-end gap-2">
                          <a
                            className={cx(
                              "inline-flex min-w-[140px] items-center justify-center rounded-xl bg-gradient-to-r from-teal-500 to-cyan-500 px-4 py-2.5 text-center text-sm font-semibold text-white shadow-lg shadow-cyan-950/20 transition hover:from-teal-400 hover:to-cyan-400 hover:shadow-cyan-500/20 focus:outline-none focus:ring-2 focus:ring-cyan-300/60",
                              selectionEmpty && "pointer-events-none opacity-50",
                            )}
                            href={`/api/credentials/oauth/${connector.provider}/connect`}
                            aria-disabled={selectionEmpty}
                            onClick={(event) =>
                              handleOAuthConnect(event, connector, {
                                scopes: selectedScopes,
                                sendScopes: hasCustomSelection,
                              })
                            }
                          >
                            <span className="truncate whitespace-nowrap">
                              {connected ? `Reconnect ${profileLabel}` : `Connect ${profileLabel}`}
                            </span>
                          </a>
                          {connected && connection && (
                            <button
                              type="button"
                              className="inline-flex min-w-[140px] items-center justify-center rounded-xl border border-border/80 bg-card/70 px-4 py-2 text-sm font-medium text-muted-foreground transition hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={Boolean(revokingConnections[connection.id])}
                              aria-label={`Clear ${profileLabel} connection`}
                              onClick={() => void handleClearConnection(connection, profileLabel)}
                            >
                              {revokingConnections[connection.id]
                                ? "Clearing…"
                                : "Clear connection"}
                            </button>
                          )}
                          {allowedScopes.length > 0 && (
                            <button
                              type="button"
                              className="text-xs font-medium text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline"
                              aria-expanded={advancedOpen}
                              aria-controls={`advanced-scopes-${connector.id}`}
                              onClick={() =>
                                setExpandedAdvanced((current) => ({
                                  ...current,
                                  [connector.id]: !current[connector.id],
                                }))
                              }
                            >
                              {advancedOpen ? "Hide permissions" : "Permissions"}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {advancedOpen && allowedScopes.length > 0 && (
                      <tr className="bg-muted/15">
                        <td colSpan={6} className="px-5 py-4" id={`advanced-scopes-${connector.id}`}>
                          <fieldset className="space-y-3">
                            <legend className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                              {profileLabel} permissions requested
                            </legend>
                            <p className="text-xs text-muted-foreground">
                              Choose which permissions this app can request. You can only pick from
                              what this connection allows.
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {allowedScopes.map((scope) => {
                                const checked = selectedScopes.includes(scope);
                                return (
                                  <label
                                    key={scope}
                                    className={cx(
                                      "inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition",
                                      checked
                                        ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-700 dark:text-cyan-200"
                                        : "border-border/70 bg-card/60 text-muted-foreground hover:border-border",
                                    )}
                                  >
                                    <input
                                      type="checkbox"
                                      className="h-3.5 w-3.5 accent-cyan-500"
                                      checked={checked}
                                      onChange={() => toggleScope(scope)}
                                    />
                                    <span className="font-mono">{scope}</span>
                                  </label>
                                );
                              })}
                            </div>
                            {connection?.requestedScopes && connection.requestedScopes.length > 0 && (
                              <p className="text-xs text-muted-foreground">
                                Current permissions: {connection.requestedScopes.join(", ")}
                              </p>
                            )}
                            {connected && (
                              <p className="text-xs text-amber-700 dark:text-amber-300">
                                Reconnect {profileLabel} for permission changes to take effect.
                              </p>
                            )}
                            {selectionEmpty && (
                              <p className="text-xs text-destructive">Select at least one scope.</p>
                            )}
                          </fieldset>
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
            <div className="space-y-2 border-t border-border/70 bg-muted/20 px-5 py-4">
              {connectionRows.map(({ connector, connection }) => {
                const profileCheck = connection ? profileChecks[connection.id] : undefined;
                const autoRefreshState = connection ? autoRefreshStates[connection.id] : undefined;
                const profileLabel = profileProviderLabel(connector.provider, connector.name);
                const tokenHealth = describeProviderConnectionHealth(connection);
                const isExpired = tokenHealth === "expired";
                if (!profileCheck?.result && !profileCheck?.error && !autoRefreshState?.error && !isExpired) return null;
                return (
                  <div key={`${connector.id}-profile-check`}>
                    {isExpired && (
                      <p className="text-xs font-medium text-rose-700 dark:text-rose-300">
                        {profileLabel} connection expired. Reconnect {profileLabel} to restore access.
                      </p>
                    )}
                    {autoRefreshState?.error && (
                      <p className="text-xs text-destructive">
                        {profileLabel} could not refresh. Reconnect {profileLabel} to restore access.
                      </p>
                    )}
                    {profileCheck?.result && (
                      <ProfileCheckResult
                        connectorName={profileLabel}
                        result={profileCheck.result}
                        onViewDetails={() =>
                          setDiagnosticModal({
                            connector,
                            connection,
                            connectorName: profileLabel,
                            result: profileCheck.result as ProviderProfileCheckResult,
                          })
                        }
                      />
                    )}
                    {profileCheck?.error && (
                      <p className="text-xs text-destructive">
                        {profileLabel} connection test failed: {profileCheck.error}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : connections.length > 0 ? (
          <ul className="divide-y divide-border">
            {connections.map((connection) => (
              <li key={connection.id} className="flex items-center justify-between gap-4 p-4">
                <span className="font-medium">{connection.provider}</span>
                <span className="rounded bg-muted px-2 py-1 text-xs">{connection.status}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">No apps connected yet.</p>
        )}
      </div>
      {diagnosticModal && (
        <TokenDiagnosticsModal
          connectorName={diagnosticModal.connectorName}
          result={diagnosticModal.result}
          onRunAgain={() => void handleProfileCheck(diagnosticModal.connector, diagnosticModal.connection)}
          onClose={() => setDiagnosticModal(null)}
        />
      )}
    </section>
  );
}

function ProfileCheckResult({
  connectorName,
  result,
  onViewDetails,
}: {
  connectorName: string;
  result: ProviderProfileCheckResult;
  onViewDetails?: () => void;
}) {
  const atlassianResourceSummary = summarizeAtlassianResources(result.accessible_resources);
  const summary =
    result.ok && atlassianResourceSummary
      ? `${connectorName} access check passed`
      : result.ok
        ? `${connectorName} connection test passed`
        : `${connectorName} connection test failed`;
  const details =
    result.ok && atlassianResourceSummary
      ? atlassianResourceSummary
      : result.ok
        ? summarizeProfile(result.profile)
        : result.message ?? "Provider did not accept the current token.";
  const warning =
    result.ok
    && !atlassianResourceSummary
    && result.profile_check?.ok === false
    && typeof result.profile_check.status === "number"
      ? `profile endpoint returned HTTP ${result.profile_check.status}`
      : "";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className={result.ok ? "text-xs font-medium text-emerald-700 dark:text-emerald-300" : "text-xs text-destructive"}>
        {summary}
        {details ? `: ${details}` : ""}
        {warning ? ` (${warning})` : ""}
      </p>
      {result.diagnostics?.length ? (
        <button
          type="button"
          className="rounded-full border border-cyan-400/40 px-2.5 py-1 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-400/10 dark:text-cyan-200"
          onClick={onViewDetails}
        >
          View details
        </button>
      ) : null}
    </div>
  );
}

function TokenDiagnosticsModal({
  connectorName,
  result,
  onRunAgain,
  onClose,
}: {
  connectorName: string;
  result: ProviderProfileCheckResult;
  onRunAgain: () => void;
  onClose: () => void;
}) {
  const rawDiagnostics = result.diagnostics ?? [];
  const hasActionableDiagnostic = rawDiagnostics.some(
    (diagnostic) => diagnostic.status !== "passed",
  );
  const diagnostics = rawDiagnostics.filter((diagnostic) => {
    if (diagnostic.id === "token_refresh") {
      return diagnostic.status !== "passed";
    }
    if (hasActionableDiagnostic && diagnostic.status === "passed" && diagnostic.action === "No action needed.") {
      return false;
    }
    return true;
  });
  const headingId = `token-diagnostics-${connectorName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-title`;
  const overallTone = result.ok ? "good" : "danger";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="w-full max-w-2xl overflow-hidden rounded-3xl border border-border bg-background shadow-2xl"
      >
        <div className="border-b border-border/70 bg-gradient-to-r from-slate-950 to-slate-800 px-6 py-5 text-white">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-200">
                Connection test
              </p>
              <h3 id={headingId} className="mt-1 text-xl font-semibold">
                {connectorName} connection details
              </h3>
            </div>
            <button
              type="button"
              className="rounded-full border border-white/20 px-3 py-1 text-sm font-semibold text-white/90 transition hover:bg-white/10"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
        <div className="space-y-5 px-6 py-5">
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill tone={overallTone}>{result.ok ? "ready to use" : "action needed"}</StatusPill>
            {result.next_action && diagnostics.length === 0 && (
              <p className="text-sm text-muted-foreground">{result.next_action}</p>
            )}
            <button
              type="button"
              className="ml-auto rounded-full border border-cyan-400/40 px-3 py-1.5 text-sm font-semibold text-cyan-700 transition hover:bg-cyan-400/10 dark:text-cyan-200"
              onClick={onRunAgain}
            >
              Test {connectorName} again
            </button>
          </div>
          <div className="space-y-3">
            {diagnostics.map((diagnostic) => (
              <div
                key={diagnostic.id}
                className="rounded-2xl border border-border/80 bg-card/70 p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold text-foreground">{diagnostic.label}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {diagnostic.detail}
                    </p>
                  </div>
                  <StatusPill tone={diagnosticStatusTone(diagnostic.status)}>
                    {diagnostic.status}
                  </StatusPill>
                </div>
                <p className="mt-3 rounded-xl bg-muted/50 px-3 py-2 text-sm text-foreground">
                  What to do: {diagnostic.action}
                </p>
              </div>
            ))}
          </div>
          {diagnostics.length === 0 && (
            <p className="rounded-2xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
              No detailed diagnostics were returned for this connection test.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function summarizeAtlassianResources(resources: Array<Record<string, unknown>> | undefined): string {
  if (!resources?.length) return "";
  const names = resources
    .map((resource) => resource.name)
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  if (names.length > 0) return names.slice(0, 3).join(", ");
  const urls = resources
    .map((resource) => resource.url)
    .filter((url): url is string => typeof url === "string" && url.trim().length > 0);
  if (urls.length > 0) return urls.slice(0, 3).join(", ");
  return `${resources.length} accessible resource${resources.length === 1 ? "" : "s"}`;
}

function summarizeProfile(profile: Record<string, unknown> | undefined): string {
  if (!profile) return "";
  for (const key of ["login", "name", "email", "displayName", "userName", "account_id", "id"]) {
    const value = profile[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return String(value);
  }
  const emails = profile.emails;
  if (Array.isArray(emails) && typeof emails[0] === "string") return emails[0];
  return "";
}

function needsAutoRefresh(connection: ProviderConnection): boolean {
  if (connection.status !== "connected" || !connection.expiresAt) return false;
  if (connection.renewable === false) return false;
  const expiresAt = new Date(connection.expiresAt).getTime();
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt <= Date.now() + 15 * 60 * 1000;
}

function providerAccentClasses(provider: string): string {
  switch (provider) {
    case "github":
      return "bg-gradient-to-br from-slate-800 to-slate-500 shadow-slate-950/20";
    case "atlassian":
      return "bg-gradient-to-br from-slate-950 via-blue-950 to-sky-900 shadow-blue-950/30";
    case "webex":
      return "bg-gradient-to-br from-slate-950 via-cyan-950 to-teal-900 shadow-cyan-950/30";
    case "pagerduty":
      return "bg-gradient-to-br from-emerald-600 to-lime-500 shadow-emerald-950/20";
    case "gitlab":
      return "bg-gradient-to-br from-orange-500 to-amber-400 shadow-orange-950/20";
    case "amplitude":
      return "bg-gradient-to-br from-slate-900 via-orange-950 to-orange-900 shadow-orange-950/30";
    default:
      return "bg-gradient-to-br from-violet-600 to-fuchsia-400 shadow-violet-950/20";
  }
}

function ProviderLogo({ provider }: { provider: string }) {
  switch (provider) {
    case "github":
      return (
        <svg aria-hidden="true" className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.2-.02-2.18-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.16 1.18A10.97 10.97 0 0 1 12 6.03c.98 0 1.96.13 2.88.39 2.19-1.49 3.15-1.18 3.15-1.18.63 1.58.24 2.75.12 3.04.74.8 1.18 1.83 1.18 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.13 0 1.54-.01 2.78-.01 3.16 0 .31.21.68.79.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
        </svg>
      );
    case "atlassian":
      return (
        // Provider SVGs intentionally bypass the Next.js image pipeline.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          aria-hidden="true"
          className="h-7 w-7 object-contain"
          height={28}
          src="/provider-logos/atlassian.svg"
          width={28}
        />
      );
    case "webex":
      return (
        // Provider SVGs intentionally bypass the Next.js image pipeline.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          aria-hidden="true"
          className="h-7 w-7 object-contain"
          height={28}
          src="/provider-logos/webex.svg"
          width={28}
        />
      );
    case "pagerduty":
      return (
        <svg aria-hidden="true" className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor">
          <path d="M5.25 2.25h7.65c3.66 0 6.45 2.68 6.45 6.22 0 3.62-2.79 6.32-6.45 6.32H9.64v6.96H5.25V2.25Zm7.17 8.76c1.52 0 2.55-1.02 2.55-2.48 0-1.42-1.03-2.41-2.55-2.41H9.64v4.89h2.78Z" />
        </svg>
      );
    case "gitlab":
      return (
        <svg aria-hidden="true" className="h-7 w-7" viewBox="0 0 24 24" fill="currentColor">
          <path d="m12 21.15 3.95-12.17H8.05L12 21.15Z" opacity=".95" />
          <path d="M2.35 8.98 12 21.15 8.05 8.98H2.35Z" opacity=".72" />
          <path d="M21.65 8.98 12 21.15l3.95-12.17h5.7Z" opacity=".72" />
          <path d="M2.35 8.98 4.1 3.6c.18-.55.95-.55 1.13 0l2.82 5.38h-5.7ZM21.65 8.98 19.9 3.6c-.18-.55-.95-.55-1.13 0l-2.82 5.38h5.7Z" />
        </svg>
      );
    case "amplitude":
      return (
        // Provider SVGs intentionally bypass the Next.js image pipeline.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          aria-hidden="true"
          className="h-7 w-7 object-contain"
          height={28}
          src="/provider-logos/amplitude.svg"
          width={28}
        />
      );
    default:
      return <span aria-hidden="true" className="text-[10px] tracking-tight">OAuth</span>;
  }
}

function LinkTestIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none">
      <path d="M10 13.5a4 4 0 0 0 5.66 0l2.84-2.84A4 4 0 0 0 12.84 5L11.5 6.34" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      <path d="M14 10.5a4 4 0 0 0-5.66 0L5.5 13.34A4 4 0 0 0 11.16 19l1.34-1.34" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      <path d="m17 17 3 3M20 17l-3 3" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="2" />
      <path d="m8.5 12.2 2.25 2.25 4.9-5.1" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" />
    </svg>
  );
}

function AlertCircleIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7.5v5.25M12 16.5h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="2.2" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeOpacity=".25" strokeWidth="2.5" />
      <path d="M20 12a8 8 0 0 0-8-8" stroke="currentColor" strokeLinecap="round" strokeWidth="2.5" />
    </svg>
  );
}

function healthTone(health: string): "good" | "warning" | "danger" | "neutral" {
  switch (health) {
    case "healthy":
    case "connected":
    // Connected and usable now — it simply won't auto-renew. Green, not amber:
    // amber is reserved for connections that are within minutes of lapsing.
    case "no auto-renew":
      return "good";
    case "expiring soon":
    case "relink required":
      return "warning";
    case "expired":
      return "danger";
    default:
      return "neutral";
  }
}

function diagnosticStatusTone(status: TokenDiagnostic["status"]): "good" | "warning" | "danger" | "neutral" {
  if (status === "passed") return "good";
  if (status === "warning") return "warning";
  return "danger";
}

function connectionStatusTone(connection: ProviderConnection | null): "good" | "warning" | "danger" | "neutral" {
  if (!connection) return "neutral";
  if (connection.status === "connected") return "good";
  if (connection.status === "error" || connection.status === "failed") return "danger";
  return "warning";
}

function ConnectionStatusMark({
  connection,
  providerLabel,
}: {
  connection: ProviderConnection | null;
  providerLabel: string;
}) {
  const status = connection?.status ?? "not connected";
  const tone = connectionStatusTone(connection);
  const className = cx(
    "inline-flex h-8 w-8 items-center justify-center rounded-full border shadow-sm ring-1 ring-white/[0.04]",
    tone === "good" && "border-emerald-400/40 bg-emerald-400/10 text-emerald-700 dark:text-emerald-300",
    tone === "warning" && "border-amber-400/40 bg-amber-400/10 text-amber-700 dark:text-amber-300",
    tone === "danger" && "border-rose-400/40 bg-rose-400/10 text-rose-700 dark:text-rose-300",
    tone === "neutral" && "border-slate-400/30 bg-slate-400/10 text-slate-600 dark:text-slate-300",
  );

  return (
    <span
      className={className}
      role="img"
      aria-label={`${providerLabel} connection status ${status}`}
      title={`${providerLabel}: ${status}`}
    >
      {status === "connected" ? (
        <CheckCircleIcon />
      ) : tone === "danger" ? (
        <AlertCircleIcon />
      ) : (
        <LinkTestIcon />
      )}
    </span>
  );
}

function StatusPill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "good" | "warning" | "danger" | "neutral";
}) {
  const toneClass =
    tone === "good"
      ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-700 dark:text-emerald-300"
      : tone === "warning"
        ? "border-amber-400/50 bg-amber-400/10 text-amber-700 dark:text-amber-300"
        : tone === "danger"
          ? "border-rose-400/50 bg-rose-400/10 text-rose-700 dark:text-rose-300"
          : "border-slate-400/30 bg-slate-400/10 text-slate-600 dark:text-slate-300";

  return (
    <span
      className={cx(
        "inline-flex min-w-[82px] items-center justify-center rounded-full border px-2.5 py-1 text-xs font-semibold capitalize shadow-sm",
        toneClass,
      )}
    >
      {children}
    </span>
  );
}

function profileProviderLabel(provider: string, fallback: string): string {
  switch (provider) {
    case "github":
      return "GitHub";
    case "atlassian":
      return "Atlassian";
    case "webex":
      return "Webex";
    case "pagerduty":
      return "PagerDuty";
    case "gitlab":
      return "GitLab";
    default:
      return fallback;
  }
}

function formatDateTime(value: string | Date | undefined): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
}
