"use client";

import { ADMIN_STATS_SECTIONS,type AdminStatsData,type AdminStatsSection } from "@/types/admin-stats";
import { useCallback,useEffect,useMemo,useRef,useState } from "react";

interface AdminStatsSectionStatus {
  error: string | null;
  loading: boolean;
}

type AdminStatsSectionStatuses = Record<AdminStatsSection, AdminStatsSectionStatus>;

interface UseAdminStatsSectionsOptions {
  getSectionUrl: (section: AdminStatsSection) => string;
  onFatalError?: (message: string) => void;
  scopeKey: string;
}

interface AdminStatsSectionError extends Error {
  status?: number;
}

const createSectionStatuses = (): AdminStatsSectionStatuses => Object.fromEntries(
  ADMIN_STATS_SECTIONS.map((section) => [section, { error: null, loading: false }]),
) as AdminStatsSectionStatuses;

function mergeSectionData(
  current: AdminStatsData,
  section: AdminStatsSection,
  incoming: AdminStatsData,
): AdminStatsData {
  const next = { ...current, ...incoming };

  // The Slack/Webex sections are optional when no data exists for that
  // source. A successful refresh with no key must clear stale data from the
  // prior filter selection.
  if (section === 'slack' && !Object.hasOwn(incoming, 'slack')) {
    delete next.slack;
  }
  if (section === 'webex' && !Object.hasOwn(incoming, 'webex')) {
    delete next.webex;
  }
  if (section === 'api' && !Object.hasOwn(incoming, 'api')) {
    delete next.api;
  }

  return next;
}

export function useAdminStatsSections({
  getSectionUrl,
  onFatalError,
  scopeKey,
}: UseAdminStatsSectionsOptions) {
  const [data, setData] = useState<AdminStatsData>({});
  const [statuses, setStatuses] = useState<AdminStatsSectionStatuses>(createSectionStatuses);
  const abortControllersRef = useRef<Partial<Record<AdminStatsSection, AbortController>>>({});
  const requestVersionsRef = useRef<Record<AdminStatsSection, number>>(
    Object.fromEntries(ADMIN_STATS_SECTIONS.map((section) => [section, 0])) as Record<AdminStatsSection, number>,
  );
  const activeScopeKeyRef = useRef(scopeKey);
  const getSectionUrlRef = useRef(getSectionUrl);
  const onFatalErrorRef = useRef(onFatalError);

  activeScopeKeyRef.current = scopeKey;
  getSectionUrlRef.current = getSectionUrl;
  onFatalErrorRef.current = onFatalError;

  const loadSections = useCallback(async (
    sections: readonly AdminStatsSection[] = ADMIN_STATS_SECTIONS,
  ): Promise<void> => {
    const requestScopeKey = activeScopeKeyRef.current;

    setStatuses((current) => {
      const next = { ...current };
      for (const section of sections) {
        next[section] = { error: null, loading: true };
      }
      return next;
    });

    await Promise.allSettled(sections.map(async (section) => {
      abortControllersRef.current[section]?.abort();
      const controller = new AbortController();
      abortControllersRef.current[section] = controller;
      const requestVersion = requestVersionsRef.current[section] + 1;
      requestVersionsRef.current[section] = requestVersion;

      try {
        const response = await fetch(getSectionUrlRef.current(section), {
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null);

        if (!response.ok || !body?.success) {
          const message = response.status === 401
            ? 'Not authenticated. Please sign in via SSO first.'
            : response.status === 403
              ? 'Access denied. Try signing out and back in to refresh your session.'
              : body?.error || `Failed to load ${section.replaceAll('_', ' ')}`;
          const error = new Error(message) as AdminStatsSectionError;
          error.status = response.status;
          throw error;
        }

        if (
          activeScopeKeyRef.current !== requestScopeKey
          || requestVersionsRef.current[section] !== requestVersion
        ) return;

        setData((current) => mergeSectionData(current, section, body.data ?? {}));
        setStatuses((current) => ({
          ...current,
          [section]: { error: null, loading: false },
        }));
      } catch (error) {
        if (controller.signal.aborted) return;
        if (
          activeScopeKeyRef.current !== requestScopeKey
          || requestVersionsRef.current[section] !== requestVersion
        ) return;

        const requestError = error as AdminStatsSectionError;
        const message = requestError.message || `Failed to load ${section.replaceAll('_', ' ')}`;
        setStatuses((current) => ({
          ...current,
          [section]: { error: message, loading: false },
        }));

        if (requestError.status === 401 || requestError.status === 403) {
          onFatalErrorRef.current?.(message);
        }
      }
    }));
  }, []);

  const reset = useCallback((): void => {
    for (const section of ADMIN_STATS_SECTIONS) {
      abortControllersRef.current[section]?.abort();
      requestVersionsRef.current[section] += 1;
    }
    abortControllersRef.current = {};
    setData({});
    setStatuses(createSectionStatuses());
  }, []);

  useEffect(() => () => {
    for (const controller of Object.values(abortControllersRef.current)) {
      controller?.abort();
    }
  }, []);

  const refreshing = useMemo(
    () => Object.values(statuses).some(({ loading }) => loading),
    [statuses],
  );

  return {
    data,
    loadSections,
    refreshing,
    reset,
    statuses,
  };
}
