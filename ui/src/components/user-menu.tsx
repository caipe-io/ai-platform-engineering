"use client";

import type { ChangelogRelease } from "@/app/api/changelog/route";
import { ApplicationVersion } from "@/components/layout/ApplicationVersion";
import { ReportProblemDialog } from "@/components/ticket/ReportProblemDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { config } from "@/lib/config";
import { cn } from "@/lib/utils";
import { AnimatePresence,motion } from "framer-motion";
import { Bug,ChevronDown,ChevronRight,ExternalLink,Info,Lightbulb,Loader2,LogIn,LogOut,Shield,Tag } from "lucide-react";
import { signIn,signOut,useSession } from "next-auth/react";
import Image from "next/image";
import { NavigationProgressLink } from "@/components/layout/NavigationProgressLink";
import { useCallback,useEffect,useRef,useState } from "react";

const RELEASES_URL = "https://github.com/caipe-io/ai-platform-engineering/releases";

export function UserMenu(): React.ReactElement | null {
  const { data: session,status } = useSession();
  const [open,setOpen] = useState(false);
  const [aboutOpen,setAboutOpen] = useState(false);
  const [reportDialogOpen,setReportDialogOpen] = useState(false);
  const [releases,setReleases] = useState<ChangelogRelease[]>([]);
  const [changelogLoading,setChangelogLoading] = useState(false);
  const [changelogError,setChangelogError] = useState<string | null>(null);
  const changelogFetched = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const fetchChangelog = useCallback(async () => {
    if (changelogFetched.current) return;
    changelogFetched.current = true;
    setChangelogLoading(true);
    setChangelogError(null);
    try {
      const response = await fetch("/api/changelog");
      if (!response.ok) throw new Error("Could not load the changelog");
      const data = await response.json();
      setReleases(data.releases || []);
    } catch (error) {
      console.error("[UserMenu] Changelog fetch failed",error);
      setChangelogError("Unable to load the changelog.");
    } finally {
      setChangelogLoading(false);
    }
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown",handleClickOutside);
    return () => document.removeEventListener("mousedown",handleClickOutside);
  }, [open]);

  useEffect(() => {
    function handleOpenChangelog() {
      setAboutOpen(true);
      setOpen(false);
      void fetchChangelog();
    }
    window.addEventListener("open-changelog",handleOpenChangelog);
    return () => window.removeEventListener("open-changelog",handleOpenChangelog);
  }, [fetchChangelog]);

  if (!config.ssoEnabled) return null;

  if (status === "loading") {
    return <div className="h-8 w-8 animate-pulse rounded-full bg-muted" />;
  }

  if (status === "unauthenticated") {
    return (
      <Button className="gap-1.5 text-xs" onClick={() => signIn("oidc")} size="sm" variant="ghost">
        <LogIn className="h-3.5 w-3.5" />
        Sign In
      </Button>
    );
  }

  const displayName = session?.user?.name || "User";
  const userInitials = session?.user?.name
    ? session.user.name.split(" ").map((part) => part[0]).join("").toUpperCase().slice(0,2)
    : "U";
  const isAdmin = session?.role === "admin";

  return (
    <div className="relative" ref={menuRef}>
      <button
        aria-label={`User menu for ${displayName}`}
        className={cn(
          "flex items-center gap-1.5 rounded-full px-1.5 py-1 transition-colors",
          open ? "bg-primary/10" : "hover:bg-muted",
        )}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {session?.user?.image ? (
          <Image
            alt={displayName}
            className="h-6 w-6 rounded-full"
            height={24}
            src={session.user.image}
            unoptimized
            width={24}
          />
        ) : (
          <span className="gradient-primary-br flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-medium text-white">
            {userInitials}
          </span>
        )}
        <ChevronDown className={cn("h-3 w-3 text-muted-foreground transition-transform",open && "rotate-180")} />
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            animate={{ opacity: 1,y: 0,scale: 1 }}
            className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-card shadow-xl"
            exit={{ opacity: 0,y: -10,scale: 0.95 }}
            initial={{ opacity: 0,y: -10,scale: 0.95 }}
            transition={{ duration: 0.15 }}
          >
            <div className="border-b border-border p-3">
              <div className="flex items-center gap-3">
                {session?.user?.image ? (
                  <Image
                    alt={displayName}
                    className="h-10 w-10 rounded-full"
                    height={40}
                    src={session.user.image}
                    unoptimized
                    width={40}
                  />
                ) : (
                  <span className="gradient-primary-br flex h-10 w-10 items-center justify-center rounded-full text-sm font-medium text-white">
                    {userInitials}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{displayName}</p>
                    <span className={cn(
                      "shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                      isAdmin
                        ? "border-primary/30 bg-primary/20 text-primary"
                        : "border-border bg-muted text-muted-foreground",
                    )}>
                      {isAdmin ? "Admin" : "User"}
                    </span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{session?.user?.email || ""}</p>
                </div>
              </div>
            </div>

            <div className="border-b border-border bg-muted/30 p-2">
              <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
                <Shield className="h-3 w-3 shrink-0" />
                <span>Authenticated via SSO</span>
                <span aria-hidden="true" className="text-muted-foreground/50">|</span>
                <span className={cn("font-medium",isAdmin && "text-primary")}>Role: {isAdmin ? "Admin" : "User"}</span>
              </div>
            </div>

            {config.mongodbEnabled ? (
              <div className="border-b border-border">
                <NavigationProgressLink
                  className="flex w-full items-center justify-between px-4 py-2 text-xs font-medium transition-colors hover:bg-muted/50"
                  href="/insights"
                  onClick={() => setOpen(false)}
                >
                  <span className="flex items-center gap-2"><Lightbulb className="h-3.5 w-3.5" />Personal Insights</span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </NavigationProgressLink>
              </div>
            ) : null}

            {config.reportProblemEnabled ? (
              <div className="border-b border-border">
                <button
                  className="flex w-full items-center justify-between px-4 py-2 text-xs font-medium transition-colors hover:bg-muted/50"
                  onClick={() => {
                    setReportDialogOpen(true);
                    setOpen(false);
                  }}
                  type="button"
                >
                  <span className="flex items-center gap-2">
                    <Bug className="h-3.5 w-3.5" />
                    Report a Problem
                  </span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : null}

            <div className="border-b border-border">
              <button
                className="flex w-full items-center justify-between px-4 py-2 text-xs font-medium transition-colors hover:bg-muted/50"
                onClick={() => {
                  setAboutOpen(true);
                  setOpen(false);
                  void fetchChangelog();
                }}
                type="button"
              >
                <span className="flex items-center gap-2"><Info className="h-3.5 w-3.5" />About</span>
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="p-1.5">
              <button
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10"
                onClick={() => {
                  setOpen(false);
                  void signOut({ callbackUrl: "/login" });
                }}
                type="button"
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <ReportProblemDialog
        onOpenChange={setReportDialogOpen}
        open={reportDialogOpen}
      />

      <Dialog onOpenChange={setAboutOpen} open={aboutOpen}>
        <DialogContent className="max-h-[85vh] max-w-3xl p-0">
          <DialogHeader className="border-b border-border p-6 pb-4">
            <div className="flex items-center gap-3">
              <span className="gradient-primary-br rounded-xl p-2"><Info className="h-5 w-5 text-white" /></span>
              <DialogTitle>About</DialogTitle>
            </div>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto p-6">
            <div className="mb-5 rounded-lg border border-border bg-muted/20 px-3 py-2">
              <ApplicationVersion />
            </div>
            <div className="mb-4 flex items-center justify-between gap-4">
              <h3 className="text-sm font-semibold">Recent changes</h3>
              <a className="flex items-center gap-1 text-xs text-primary hover:underline" href={RELEASES_URL} rel="noopener noreferrer" target="_blank">
                Release notes <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            {changelogLoading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />Loading changelog…
              </div>
            ) : changelogError ? (
              <p className="py-8 text-center text-sm text-muted-foreground">{changelogError}</p>
            ) : (
              <div className="space-y-3">
                {releases.slice(0,10).map((release) => (
                  <details className="rounded-lg border border-border p-4" key={release.version}>
                    <summary className="cursor-pointer text-sm font-semibold">
                      <span className="inline-flex items-center gap-2"><Tag className="h-3.5 w-3.5 text-primary" />v{release.version}</span>
                      <span className="ml-2 text-xs font-normal text-muted-foreground">{release.date}</span>
                    </summary>
                    <div className="mt-3 space-y-3">
                      {release.sections.map((section) => (
                        <div key={section.type}>
                          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{section.type}</p>
                          <ul className="space-y-1 pl-4 text-xs text-foreground/80">
                            {section.items.map((item,index) => <li className="list-disc" key={`${section.type}-${index}`}>{item.text}</li>)}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </div>
          <div className="border-t border-border bg-muted/20 p-4 text-center text-xs text-muted-foreground">
            Built with ❤️ by the <a className="text-primary hover:underline" href="https://caipe.io/" rel="noopener noreferrer" target="_blank">caipe.io</a> OSS community
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
