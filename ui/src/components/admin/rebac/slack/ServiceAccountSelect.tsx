"use client";

import { SearchablePicker } from "@/components/ui/searchable-picker";
import * as React from "react";

interface ServiceAccountOption {
  sa_sub: string;
  name: string;
  status: "active" | "revoked";
}

interface ServiceAccountPayload {
  success?: boolean;
  data?: {
    items?: Array<{
      id: string;
      name: string;
      status: "active" | "revoked";
    }>;
  };
}

export function ServiceAccountSelect({
  value,
  onChange,
  teamSlug,
  displayName,
  disabled,
  error,
  id = "route-exec-sa",
  label = "Service account",
}: {
  value: string;
  onChange: (sub: string, name: string) => void;
  teamSlug?: string;
  displayName?: string;
  disabled?: boolean;
  error?: string;
  id?: string;
  label?: string;
}) {
  const [serviceAccounts, setServiceAccounts] = React.useState<
    ServiceAccountOption[]
  >([]);
  const [loading, setLoading] = React.useState(false);
  const [fetchError, setFetchError] = React.useState<string | null>(null);
  const [retryCount, setRetryCount] = React.useState(0);

  React.useEffect(() => {
    if (!teamSlug) {
      setServiceAccounts([]);
      setFetchError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    async function load(team: string): Promise<void> {
      setServiceAccounts([]);
      setLoading(true);
      setFetchError(null);
      try {
        const response = await fetch(
          `/api/admin/service-accounts?team=${encodeURIComponent(team)}`,
        );
        if (!response.ok) {
          throw new Error(`Service account request failed (${response.status})`);
        }
        const payload = (await response.json()) as ServiceAccountPayload;
        if (cancelled) return;
        setServiceAccounts(
          (payload.data?.items ?? [])
            .filter((item) => item.status === "active")
            .map((item) => ({
              sa_sub: item.id,
              name: item.name,
              status: item.status,
            })),
        );
      } catch {
        if (!cancelled) {
          setServiceAccounts([]);
          setFetchError("Failed to load service accounts.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load(teamSlug);
    return () => {
      cancelled = true;
    };
  }, [retryCount, teamSlug]);

  const fetchedSelection = serviceAccounts.find(
    (serviceAccount) => serviceAccount.sa_sub === value,
  );
  const fallbackName = displayName?.trim() || value;
  const fallbackSelection =
    fallbackName && !fetchedSelection
      ? {
          sa_sub: value,
          name: fallbackName,
          status: "active" as const,
        }
      : undefined;
  const options = value && fallbackSelection
    ? [fallbackSelection, ...serviceAccounts]
    : serviceAccounts;
  const selected = fetchedSelection ?? fallbackSelection;

  const unavailableMessage =
    !loading && !fetchError && serviceAccounts.length === 0 && !selected
      ? teamSlug
        ? `No active service accounts found for team:${teamSlug}. Create one in the Service Accounts tab.`
        : "No team assigned to this channel — assign a team first."
      : null;

  if (unavailableMessage) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          {unavailableMessage}
        </p>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <SearchablePicker
        options={options}
        selected={selected}
        onSelect={(serviceAccount) =>
          onChange(serviceAccount.sa_sub, serviceAccount.name)
        }
        getOptionKey={(serviceAccount) => serviceAccount.sa_sub}
        getOptionLabel={(serviceAccount) => serviceAccount.name}
        getSearchText={(serviceAccount) => [
          serviceAccount.sa_sub,
          serviceAccount.name,
        ]}
        placeholder="Select service account..."
        searchPlaceholder="Search service accounts..."
        emptyLabel="No service accounts match"
        id={id}
        ariaLabel={label}
        ariaInvalid={Boolean(error || fetchError)}
        disabled={disabled}
        triggerClassName="h-10"
        onClear={() => onChange("", "")}
        clearLabel="Clear service account selection"
        loading={loading}
        loadingLabel="Loading service accounts..."
        error={fetchError}
        onRetry={() => setRetryCount((count) => count + 1)}
        portalled={false}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
