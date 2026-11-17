"use client";

import { PRODUCT_TOURS, isProductTourId, type ProductTourId } from "@/lib/product-tour-catalog";
import { TOUR_ICONS } from "./tour-icons";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/shared/SettingsCard";
import {
  PRODUCT_TOUR_REQUEST_EVENT,
  PRODUCT_TOUR_AGENT_CREATED_EVENT,
  requestProductTour,
  type ProductTourPayload,
  type ProductTourState,
} from "@/lib/product-tour";
import { useCaipeTourStore } from "@/store/caipe-tour-store";
import { SettingsSwitch } from "@/components/settings/shared/SettingsSwitch";
import { getConfig } from "@/lib/config";
import { GuardedNavigationLink } from "@/components/layout/GuardedNavigationLink";
import { cn } from "@/lib/utils";
import { pushWithNavigationProgress } from "@/lib/navigation-progress";
import { useUnsavedChangesStore } from "@/store/unsaved-changes-store";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Compass,
  GraduationCap,
  Minus,
  X,
  ArrowUpRight,
  Loader2,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import React, { useCallback, useEffect, useRef, useState } from "react";

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  error?: string;
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
    return payload.error;
  }
  return fallback;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true || !payload.data?.state) {
    throw new Error(errorMessage(payload, response.ok
      ? "Tour progress is unavailable"
      : `Request failed (${response.status})`));
  }
  return payload as T;
}

async function patchTour(action: string, currentStep?: number, tourId: ProductTourId = "workspace"): Promise<ProductTourState> {
  const response = await requestJson<ApiEnvelope<{ state: ProductTourState }>>(
    "/api/onboarding/product-tour",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...(tourId === "workspace" ? {} : { tour_id: tourId }), ...(currentStep ? { current_step: currentStep } : {}) }),
    },
  );
  return response.data.state;
}

export function ProductTourDialog({
  initialPayload,
  onOpenChange,
  open,
}: {
  initialPayload: ProductTourPayload | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}): React.ReactElement {
  const tourId = initialPayload?.tour_id ?? "workspace";
  const tour = PRODUCT_TOURS[tourId];
  const steps = tour.steps;
  const pathname = usePathname();
  const router = useRouter();
  const { hasUnsavedChanges, requestNavigation } = useUnsavedChangesStore();
  const navigationStep = useRef<number | null>(null);
  const homeRequested = useRef(false);
  const [completed, setCompleted] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const [minimized, setMinimized] = useState(false);
  const [spotlight, setSpotlight] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [step, setStep] = useState(initialPayload?.state.current_step ?? 1);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(open && initialPayload?.state.status === "not_started");
  const [error, setError] = useState<string | null>(null);
  const startRequest = useRef<Promise<void>>(Promise.resolve());
  const progressRequest = useRef<Promise<unknown>>(Promise.resolve());
  const progressVersion = useRef(0);
  const observedAgentStep = useRef<string | null | undefined>(undefined);
  const agentCreated = useRef(false);

  useEffect(() => {
    if (!open) return;
    setMinimized(false);
    setCompleted(false);
    navigationStep.current = null;
    homeRequested.current = false;
    setError(null);
    setStep(initialPayload?.state.current_step ?? 1);
    observedAgentStep.current = undefined;
    agentCreated.current = initialPayload?.state.current_step === 5;
    if (initialPayload?.state.status === "not_started") {
      setStarting(true);
      startRequest.current = patchTour("start", initialPayload.state.current_step, tourId)
        .then(() => undefined)
        .catch((reason) => {
          setError(reason instanceof Error ? reason.message : "Could not start the tour");
        })
        .finally(() => setStarting(false));
    } else {
      setStarting(false);
    }
  }, [initialPayload, open, tourId]);

  const move = useCallback(async (nextStep: number) => {
    const version = ++progressVersion.current;
    setSaving(true);
    setError(null);
    try {
      await startRequest.current;
      const request = progressRequest.current.catch(() => undefined)
        .then(() => patchTour("progress", nextStep, tourId));
      progressRequest.current = request;
      await request;
      if (progressVersion.current === version) setStep(nextStep);
    } catch (reason) {
      if (progressVersion.current === version) setError(reason instanceof Error ? reason.message : "Could not save tour progress");
    } finally {
      if (progressVersion.current === version) setSaving(false);
    }
  }, [tourId]);

  useEffect(() => {
    if (!open || tourId !== "add-agent") return;
    const update = () => {
      if (agentCreated.current) return;
      const builderStep = document.querySelector("[data-tour-agent-step]")?.getAttribute("data-tour-agent-step") ?? null;
      if (observedAgentStep.current === builderStep) return;
      observedAgentStep.current = builderStep;
      const next = builderStep === "basic" ? 2 : builderStep === "instructions" ? 3 : builderStep ? 4 : 1;
      // Guidance follows the real form without clicking or bypassing its controls.
      setStep(next);
      void move(next);
    };
    const created = () => {
      agentCreated.current = true;
      setStep(5);
      void move(5);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-tour-agent-step"] });
    window.addEventListener(PRODUCT_TOUR_AGENT_CREATED_EVENT, created);
    return () => {
      observer.disconnect();
      window.removeEventListener(PRODUCT_TOUR_AGENT_CREATED_EVENT, created);
    };
  }, [move, open, tourId]);

  const dismiss = async () => {
    if (completed) { onOpenChange(false); return; }
    setSaving(true);
    setError(null);
    try {
      await startRequest.current;
      await progressRequest.current.catch(() => undefined);
      await patchTour("dismiss", step, tourId);
    } catch {
      setError("Tour closed, but dismissal could not be saved. It may appear again next time.");
    } finally {
      setSaving(false);
      onOpenChange(false);
    }
  };

  const complete = async () => {
    setSaving(true);
    setError(null);
    try {
      await startRequest.current;
      await progressRequest.current;
      await patchTour("complete", steps.length, tourId);
      setCompleted(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not complete the tour");
    } finally {
      setSaving(false);
    }
  };

  const active = steps[step - 1] ?? steps[0];
  const Icon = TOUR_ICONS[active.icon];

  useEffect(() => {
    if (!open || minimized || completed || navigationStep.current === step) return;
    navigationStep.current = step;
    // Form-only steps inherit their workspace; never reopen a form or replace
    // a conversation that is already on the requested page.
    const href = steps.slice(0, step).findLast((item) => item.href)?.href;
    if (!href) return;
    const target = new URL(href, window.location.origin);
    const currentQuery = new URLSearchParams(window.location.search);
    const samePage = pathname === target.pathname
      || (target.pathname === "/chat" && pathname.startsWith("/chat/"));
    if (samePage && [...target.searchParams].every(([key, value]) => currentQuery.get(key) === value)) return;
    if (hasUnsavedChanges) requestNavigation(href);
    else pushWithNavigationProgress(router, href);
  }, [completed, hasUnsavedChanges, minimized, open, pathname, requestNavigation, router, step, steps]);

  useEffect(() => {
    if (completed && homeRequested.current && pathname === "/") onOpenChange(false);
  }, [completed, onOpenChange, pathname]);

  useEffect(() => {
    if (open && !minimized) panelRef.current?.focus({ preventScroll: true });
  }, [open, minimized, completed]);

  useEffect(() => {
    if (!open || minimized) return;
    const update = () => {
      const element = document.querySelector(active.target);
      const rect = element?.getBoundingClientRect();
      setSpotlight(rect && rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight
        ? { left: Math.max(4, rect.left - 5), top: Math.max(4, rect.top - 5), width: Math.min(rect.width + 10, window.innerWidth - 8), height: rect.height + 10 }
        : null);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(document.body);
    const mutations = new MutationObserver(update);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [active.target, minimized, open, pathname]);

  if (!open) return error ? <p role="status" className="fixed bottom-4 left-4 z-[80] max-w-sm rounded-xl border bg-card p-4 text-sm shadow-lg">{error}</p> : <></>;
  if (minimized) return <div className="flex shrink-0 justify-end border-t p-2 xl:w-14 xl:border-l xl:border-t-0"><Button variant="outline" className="rounded-full xl:h-10 xl:w-10 xl:p-0" aria-label={`${tour.title} · Resume tour · ${step} of ${steps.length}`} onClick={() => setMinimized(false)}><Compass className="h-4 w-4" /><span className="ml-2 xl:sr-only">{tour.title} · Resume tour · {step} of {steps.length}</span></Button></div>;

  return (
    <>
      {spotlight && <div aria-hidden data-testid="product-tour-spotlight" className="pointer-events-none fixed z-[60] rounded-xl border-2 border-primary shadow-[0_0_0_9999px_rgb(0_0_0/0.15)] transition-all duration-200 motion-reduce:transition-none" style={spotlight} />}
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby="product-tour-title"
        aria-describedby="product-tour-description"
        tabIndex={-1}
        onKeyDown={(event) => { if (event.key === "Escape" && !saving && !starting) { event.stopPropagation(); void dismiss(); } }}
        className="relative z-[70] flex max-h-[45dvh] w-full shrink-0 flex-col overflow-hidden border-t border-primary/20 bg-card outline-none xl:max-h-none xl:w-[22rem] xl:border-l xl:border-t-0"
      >
        <div className="flex items-center gap-3 border-b px-5 py-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Icon className="h-4 w-4" /></span>
          <div className="min-w-0 flex-1"><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">{tour.title}</p><p className="mt-0.5 text-xs text-muted-foreground">{active.eyebrow} · {step} of {steps.length}</p></div>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Minimize tour" onClick={() => setMinimized(true)}><Minus className="h-3.5 w-3.5" /></Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Close tour" disabled={saving || starting} onClick={() => void dismiss()}><X className="h-3.5 w-3.5" /></Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <h2 id="product-tour-title" className="text-xl font-semibold tracking-tight">{completed ? "Tour complete" : active.title}</h2>
          <p id="product-tour-description" className="mt-3 text-sm leading-6 text-muted-foreground">{completed ? "You’re all set. Return to Home or keep working here." : active.description}</p>
          <ul className="mt-4 space-y-2.5">
            {!completed && active.points.map((point) => <li key={point} className="flex items-start gap-2.5 text-xs leading-5"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />{point}</li>)}
          </ul>
          {!completed && active.expected && <p className="mt-4 rounded-lg bg-primary/5 px-3 py-2 text-xs leading-5"><span className="font-medium text-primary">Look for: </span>{active.expected}</p>}
          {!completed && active.href && <GuardedNavigationLink href={active.href} className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">Reopen page<ArrowUpRight className="h-3.5 w-3.5" /></GuardedNavigationLink>}
          {!completed && tourId === "add-agent" && step < 5 && <p role="status" className="mt-4 text-xs text-muted-foreground">Use the agent form’s Next, Previous, and Create Agent buttons. This guide follows the form automatically.</p>}
          {error && <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
        </div>
        <div className="border-t px-5 py-4">
          <div className="mb-4 flex gap-1.5" aria-label={`Tour step ${step} of ${steps.length}`}>
            {steps.map((item, index) => <span key={item.eyebrow} className={cn("h-1 flex-1 rounded-full transition-colors", index < step ? "bg-primary" : "bg-muted")} />)}
          </div>
          {completed ? <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>Stay here</Button>
            <Button size="sm" asChild><GuardedNavigationLink href="/" onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              homeRequested.current = true;
              if (!event.defaultPrevented) onOpenChange(false);
            }}>Back to Home</GuardedNavigationLink></Button>
          </div> : <div className="flex items-center justify-between gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => void dismiss()} disabled={saving || starting}>Skip tour</Button>
            <div className="flex gap-2">
              {step > 1 && tourId !== "add-agent" && <Button type="button" size="sm" variant="outline" onClick={() => void move(step - 1)} disabled={saving || starting}><ChevronLeft className="mr-1 h-3.5 w-3.5" />Back</Button>}
              {step < steps.length
                ? tourId !== "add-agent" && <Button type="button" size="sm" onClick={() => void move(step + 1)} disabled={saving || starting}>{saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}Next<ChevronRight className="ml-1 h-3.5 w-3.5" /></Button>
                : <Button type="button" size="sm" onClick={() => void complete()} disabled={saving || starting}>{saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}Finish tour</Button>}
            </div>
          </div>}
        </div>
      </section>
    </>
  );
}

export function ProductTourGate(): React.ReactElement | null {
  const tourPolicy = useCaipeTourStore();
  const [payload, setPayload] = useState<ProductTourPayload | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const activeDialogVersion = useRef(0);
  const [dialogVersion, setDialogVersion] = useState(0);

  const load = useCallback(async (restart = false, id: ProductTourId = "workspace") => {
    const version = ++requestVersion.current;
    setError(null);
    try {
      let next = (await requestJson<ApiEnvelope<ProductTourPayload>>(
        id === "workspace" ? "/api/onboarding/product-tour" : `/api/onboarding/product-tour?tour=${id}`,
      )).data;
      if (requestVersion.current !== version) return;
      const policy = useCaipeTourStore.getState();
      if (!policy.loaded) policy.receive(next);
      if (next.enabled === false || (policy.loaded && (!policy.enabled || !policy.enabledTours.includes(id)))) return;
      if (restart || next.state.status === "completed" || next.state.status === "dismissed") {
        next = { ...next, state: await patchTour("reset", undefined, id) };
        if (requestVersion.current !== version) return;
      }
      activeDialogVersion.current = version;
      setDialogVersion(version);
      setPayload({ ...next, tour_id: id });
      setOpen(true);
    } catch (reason) {
      if (requestVersion.current === version) setError(reason instanceof Error ? reason.message : "Could not open the tour");
    }
  }, []);

  useEffect(() => {
    const version = ++requestVersion.current;
    let cancelled = false;
    void requestJson<ApiEnvelope<ProductTourPayload>>("/api/onboarding/product-tour")
      .then((response) => {
        if (cancelled || requestVersion.current !== version) return;
        useCaipeTourStore.getState().receive(response.data);
        activeDialogVersion.current = version;
        setDialogVersion(version);
        setPayload({ ...response.data, tour_id: "workspace" });
        setOpen(getConfig("setupWizardEnabled") && response.data.enabled !== false && response.data.auto_start);
      })
      .catch(() => {
        // Product guidance must never block access to the application.
      });
    const refresh = () => { if (document.visibilityState !== "hidden") void useCaipeTourStore.getState().refresh(); };
    window.addEventListener("focus", refresh);
    const interval = window.setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
      window.clearInterval(interval);
      useCaipeTourStore.getState().reset();
    };
  }, []);

  useEffect(() => useCaipeTourStore.subscribe((policy) => {
    if (policy.loaded && (!policy.enabled || !policy.enabledTours.includes(payload?.tour_id ?? "workspace"))) {
      requestVersion.current++;
      setOpen(false); setPayload(null); setError(null);
    }
  }), [payload]);

  useEffect(() => {
    const handleRequest = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      const id = detail?.tourId ?? "workspace";
      const policy = useCaipeTourStore.getState();
      if (isProductTourId(id) && (!policy.loaded || (policy.enabled && policy.enabledTours.includes(id)))) void load(detail?.restart === true, id);
    };
    window.addEventListener(PRODUCT_TOUR_REQUEST_EVENT, handleRequest);
    return () => window.removeEventListener(PRODUCT_TOUR_REQUEST_EVENT, handleRequest);
  }, [load]);

  return <>
    {error && <p role="alert" className="fixed bottom-4 right-4 z-[80] max-w-sm rounded-xl border bg-card p-4 text-sm shadow-lg">{error}</p>}
    {payload && <ProductTourDialog key={dialogVersion} initialPayload={payload} open={open && (!tourPolicy.loaded || (tourPolicy.enabled && tourPolicy.enabledTours.includes(payload.tour_id ?? "workspace")))} onOpenChange={(nextOpen) => { if (activeDialogVersion.current === dialogVersion) setOpen(nextOpen); }} />}
  </>;
}

export function ProductTourSettings(): React.ReactElement {
  const policy = useCaipeTourStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void useCaipeTourStore.getState().refresh(); }, []);
  const toggle = async (enabled: boolean) => {
    setSaving(true); setError(null);
    try {
      const response = await requestJson<ApiEnvelope<ProductTourPayload>>("/api/onboarding/product-tour", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "set_enabled", enabled }),
      });
      useCaipeTourStore.getState().receive(response.data);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save CAIPE Tour preference"); }
    finally { setSaving(false); }
  };
  return <SettingsCard title={<span className="flex items-center gap-2"><GraduationCap className="h-5 w-5 text-primary" />CAIPE Tour</span>} description="Choose whether to show guided tours for your account. Your progress is saved across browsers.">
    <div className="flex items-center justify-between gap-4">
      <div><p className="text-sm font-medium">Enable CAIPE Tour</p><p className="mt-1 text-xs text-muted-foreground">Turn off the tour menu and guided tours. Turn it back on here whenever you like.</p></div>
      <SettingsSwitch label="Enable CAIPE Tour" checked={policy.enabled} disabled={!policy.loaded || saving} onCheckedChange={(enabled) => void toggle(enabled)} />
    </div>
    {(error || policy.error) && <p role="alert" className="mt-3 text-sm text-destructive">{error || policy.error}</p>}
    {!policy.loaded && policy.error && <Button className="mt-3" variant="outline" onClick={() => void policy.refresh()}>Retry tour settings</Button>}
    {policy.loaded && !policy.enabledTours.includes("workspace") && <p className="mt-3 text-xs text-muted-foreground">{policy.enabledTours.length === 0 ? "Your operator has not enabled any CAIPE Tours." : "Your operator has not enabled the workspace tour."}</p>}
    <Button className="mt-4" type="button" variant="outline" disabled={!policy.loaded || !policy.enabled || !policy.enabledTours.includes("workspace") || saving} onClick={() => requestProductTour(true)}><GraduationCap className="mr-2 h-4 w-4" />Replay CAIPE Tour</Button>
  </SettingsCard>;
}
