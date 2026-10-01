"use client";

import {
  Bell,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleX,
  Info,
  ShieldCheck,
} from "lucide-react";
import { useRouter } from "next/navigation";
import React from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useUnsavedChangesStore } from "@/store/unsaved-changes-store";
import type {
  InAppNotificationPage,
  InAppNotificationView,
} from "@/types/in-app-notification";

const EMPTY_PAGE: InAppNotificationPage = {
  notifications: [],
  unread_count: 0,
  pagination: { page: 1, page_size: 10, total: 0, total_pages: 1 },
};

function notificationIcon(notification: InAppNotificationView) {
  if (notification.severity === "success") {
    return <CircleCheck className="h-4 w-4 text-emerald-500" aria-hidden="true" />;
  }
  if (notification.severity === "error") {
    return <CircleX className="h-4 w-4 text-red-500" aria-hidden="true" />;
  }
  if (notification.severity === "warning") {
    return <ShieldCheck className="h-4 w-4 text-amber-500" aria-hidden="true" />;
  }
  return <Info className="h-4 w-4 text-sky-500" aria-hidden="true" />;
}

function unwrapPage(value: unknown): InAppNotificationPage {
  const body = value as { data?: InAppNotificationPage } & Partial<InAppNotificationPage>;
  return body.data ?? {
    notifications: body.notifications ?? [],
    unread_count: body.unread_count ?? 0,
    pagination: body.pagination ?? EMPTY_PAGE.pagination,
  };
}

function currentNotificationHref(href: string): string {
  const legacyPrefix = "/admin?";
  if (!href.startsWith(legacyPrefix)) return href;

  const params = new URLSearchParams(href.slice(legacyPrefix.length));
  if (params.get("cat") !== "security" || params.get("tab") !== "approvals") {
    return href;
  }
  params.delete("cat");
  params.delete("tab");
  const query = params.toString();
  return query ? `/admin/security/approvals?${query}` : "/admin/security/approvals";
}

export function NotificationBell({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const { hasUnsavedChanges, requestNavigation } = useUnsavedChangesStore();
  const [open, setOpen] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState<InAppNotificationPage>(EMPTY_PAGE);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async (targetPage: number) => {
    if (!enabled) {
      setData(EMPTY_PAGE);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(
        `/api/notifications?page=${targetPage}&page_size=10`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`Notifications returned ${response.status}`);
      const next = unwrapPage(await response.json());
      setData(next);
      setPage(next.pagination.page);
    } catch {
      // Header notifications should never make the rest of the header noisy.
      // A later poll retries automatically.
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  React.useEffect(() => {
    if (!enabled) {
      setData(EMPTY_PAGE);
      return;
    }
    void load(1);
    const interval = window.setInterval(() => void load(1), 30_000);
    const refresh = () => void load(1);
    window.addEventListener("in-app-notifications:refresh", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("in-app-notifications:refresh", refresh);
    };
  }, [enabled, load]);

  const markRead = React.useCallback(async (id: string) => {
    setData((current) => ({
      ...current,
      unread_count: Math.max(
        0,
        current.unread_count -
          (current.notifications.some((item) => item.id === id && !item.read) ? 1 : 0),
      ),
      notifications: current.notifications.map((item) =>
        item.id === id ? { ...item, read: true } : item,
      ),
    }));
    await fetch(`/api/notifications/${encodeURIComponent(id)}`, {
      method: "PATCH",
      keepalive: true,
    }).catch(() => undefined);
  }, []);

  const openNotification = (notification: InAppNotificationView) => {
    void markRead(notification.id);
    setOpen(false);
    if (!notification.href) return;
    const href = currentNotificationHref(notification.href);
    if (hasUnsavedChanges) requestNavigation(href);
    else router.push(href);
  };

  const markAllRead = async () => {
    setData((current) => ({
      ...current,
      unread_count: 0,
      notifications: current.notifications.map((item) => ({ ...item, read: true })),
    }));
    await fetch("/api/notifications/read-all", {
      method: "POST",
      keepalive: true,
    }).catch(() => undefined);
  };

  if (!enabled) return null;

  const unreadLabel = data.unread_count > 99 ? "99+" : String(data.unread_count);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void load(page);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="relative h-8 w-8"
          aria-label={data.unread_count > 0
            ? `${data.unread_count} unread notifications`
            : "Notifications"}
          title="Notifications"
        >
          <Bell className="h-4 w-4" />
          {data.unread_count > 0 && (
            <span className="absolute -right-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold leading-4 text-white">
              {unreadLabel}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        className="w-[min(24rem,calc(100vw-1rem))] p-0"
      >
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div>
            <p className="text-sm font-semibold">Notifications</p>
            <p className="text-xs text-muted-foreground">
              {data.unread_count > 0
                ? `${data.unread_count} unread`
                : "You’re all caught up ✅"}
            </p>
          </div>
          {data.unread_count > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={() => void markAllRead()}>
              <CheckCheck className="h-4 w-4" />
              Mark all read
            </Button>
          )}
        </div>

        <div className="max-h-[28rem] overflow-y-auto">
          {loading && data.notifications.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              Loading notifications…
            </div>
          ) : data.notifications.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              No notifications yet... but why not try to change that?
            </div>
          ) : (
            <ul role="list">
              {data.notifications.map((notification) => (
                <li key={notification.id} className="border-b last:border-b-0">
                  <button
                    type="button"
                    onClick={() => openNotification(notification)}
                    className={cn(
                      "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      !notification.read && "bg-primary/5",
                    )}
                  >
                    <span className="mt-0.5 shrink-0">
                      {notificationIcon(notification)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {notification.title}
                        </span>
                        {notification.source_label ? (
                          <span className="shrink-0 rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                            {notification.source_label}
                          </span>
                        ) : null}
                        {notification.lifecycle_status === "resolved" ? (
                          <span className="shrink-0 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                            Resolved
                          </span>
                        ) : null}
                        {!notification.read && (
                          <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                        {notification.message}
                      </span>
                      <span className="mt-1 block text-[11px] text-muted-foreground">
                        {new Date(notification.created_at).toLocaleString()}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {data.pagination.total_pages > 1 && (
          <div className="flex items-center justify-between border-t px-3 py-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={loading || data.pagination.page <= 1}
              onClick={() => void load(data.pagination.page - 1)}
            >
              <ChevronLeft className="h-4 w-4" /> Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              {data.pagination.page} of {data.pagination.total_pages}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={loading || data.pagination.page >= data.pagination.total_pages}
              onClick={() => void load(data.pagination.page + 1)}
            >
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
