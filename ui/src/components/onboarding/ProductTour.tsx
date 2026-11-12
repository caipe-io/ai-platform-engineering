"use client";

import { PRODUCT_TOURS, isProductTourId, type ProductTourId } from "@/lib/product-tour-catalog";
import { TOUR_ICONS } from "./tour-icons";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/shared/SettingsCard";
import {
  PRODUCT_TOUR_REQUEST_EVENT,
  requestProductTour,
  type ProductTourPayload,
  type ProductTourState,
} from "@/lib/product-tour";
import { getConfig } from "@/lib/config";
import { GuardedNavigationLink } from "@/components/layout/GuardedNavigationLink";
import { cn } from "@/lib/utils";
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
import { usePathname } from "next/navigation";
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
  if (!response.ok) throw new Error(errorMessage(payload, `Request failed (${response.status})`));
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
  const panelRef = useRef<HTMLElement>(null);
  const [minimized, setMinimized] = useState(false);
  const [spotlight, setSpotlight] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [step, setStep] = useState(initialPayload?.state.current_step ?? 1);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(open && initialPayload?.state.status === "not_started");
  const [error, setError] = useState<string | null>(null);
  const startRequest = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!open) return;
    setMinimized(false);
    setError(null);
    setStep(initialPayload?.state.current_step ?? 1);
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

  const move = async (nextStep: number) => {
    setSaving(true);
    setError(null);
    try {
      await startRequest.current;
      await patchTour("progress", nextStep, tourId);
      setStep(nextStep);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save tour progress");
    } finally {
      setSaving(false);
    }
  };

  const dismiss = async () => {
    setSaving(true);
    setError(null);
    try {
      await startRequest.current;
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
      await patchTour("complete", steps.length, tourId);
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not complete the tour");
    } finally {
      setSaving(false);
    }
  };

  const active = steps[step - 1] ?? steps[0];
  const Icon = TOUR_ICONS[active.icon];

  useEffect(() => {
    if (!open || minimized) return;
    panelRef.current?.focus({ preventScroll: true });
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
  if (minimized) return <Button className="fixed bottom-20 right-4 z-[80] rounded-full shadow-lg" onClick={() => setMinimized(false)}><Compass className="mr-2 h-4 w-4" />{tour.title} · Resume tour · {step} of {steps.length}</Button>;

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
        className="fixed bottom-4 right-4 z-[80] w-[min(400px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-primary/20 bg-card/95 shadow-2xl shadow-black/20 outline-none backdrop-blur-xl sm:bottom-6 sm:right-6"
      >
        <div className="flex items-center gap-3 border-b px-5 py-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Icon className="h-4 w-4" /></span>
          <div className="min-w-0 flex-1"><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">{tour.title}</p><p className="mt-0.5 text-xs text-muted-foreground">{active.eyebrow} · {step} of {steps.length}</p></div>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Minimize tour" onClick={() => setMinimized(true)}><Minus className="h-3.5 w-3.5" /></Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Close tour" disabled={saving || starting} onClick={() => void dismiss()}><X className="h-3.5 w-3.5" /></Button>
        </div>
        <div className="max-h-[calc(100dvh-15rem)] overflow-y-auto px-5 py-5">
          <h2 id="product-tour-title" className="text-xl font-semibold tracking-tight">{active.title}</h2>
          <p id="product-tour-description" className="mt-3 text-sm leading-6 text-muted-foreground">{active.description}</p>
          <ul className="mt-4 space-y-2.5">
            {active.points.map((point) => <li key={point} className="flex items-start gap-2.5 text-xs leading-5"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />{point}</li>)}
          </ul>
          {active.expected && <p className="mt-4 rounded-lg bg-primary/5 px-3 py-2 text-xs leading-5"><span className="font-medium text-primary">Look for: </span>{active.expected}</p>}
          {active.href && <GuardedNavigationLink href={active.href} className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">{active.action}<ArrowUpRight className="h-3.5 w-3.5" /></GuardedNavigationLink>}
          {error && <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
        </div>
        <div className="border-t px-5 py-4">
          <div className="mb-4 flex gap-1.5" aria-label={`Tour step ${step} of ${steps.length}`}>
            {steps.map((item, index) => <span key={item.eyebrow} className={cn("h-1 flex-1 rounded-full transition-colors", index < step ? "bg-primary" : "bg-muted")} />)}
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => void dismiss()} disabled={saving || starting}>Skip tour</Button>
            <div className="flex gap-2">
              {step > 1 && <Button type="button" size="sm" variant="outline" onClick={() => void move(step - 1)} disabled={saving || starting}><ChevronLeft className="mr-1 h-3.5 w-3.5" />Back</Button>}
              {step < steps.length
                ? <Button type="button" size="sm" onClick={() => void move(step + 1)} disabled={saving || starting}>{saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}Next<ChevronRight className="ml-1 h-3.5 w-3.5" /></Button>
                : <Button type="button" size="sm" onClick={() => void complete()} disabled={saving || starting}>{saving && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}Finish tour</Button>}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

export function ProductTourGate(): React.ReactElement | null {
  const [payload, setPayload] = useState<ProductTourPayload | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const load = useCallback(async (restart = false, id: ProductTourId = "workspace") => {
    const version = ++requestVersion.current;
    setError(null);
    try {
      let next = restart
        ? { tour_id: id, auto_start: false, eligible: true, state: await patchTour("reset", undefined, id) }
        : (await requestJson<ApiEnvelope<ProductTourPayload>>(
            id === "workspace" ? "/api/onboarding/product-tour" : `/api/onboarding/product-tour?tour=${id}`,
          )).data;
      if (requestVersion.current !== version) return;
      if (!restart && (next.state.status === "completed" || next.state.status === "dismissed")) {
        next = { ...next, state: await patchTour("reset", undefined, id) };
        if (requestVersion.current !== version) return;
      }
      setPayload({ ...next, tour_id: id });
      setOpen(true);
    } catch (reason) {
      if (requestVersion.current === version) setError(reason instanceof Error ? reason.message : "Could not open the tour");
    }
  }, []);

  useEffect(() => {
    if (!getConfig("setupWizardEnabled")) return;
    const version = ++requestVersion.current;
    let cancelled = false;
    void requestJson<ApiEnvelope<ProductTourPayload>>("/api/onboarding/product-tour")
      .then((response) => {
        if (cancelled || requestVersion.current !== version) return;
        setPayload({ ...response.data, tour_id: "workspace" });
        setOpen(response.data.auto_start);
      })
      .catch(() => {
        // Product guidance must never block access to the application.
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handleRequest = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      const id = detail?.tourId ?? "workspace";
      if (isProductTourId(id)) void load(detail?.restart === true, id);
    };
    window.addEventListener(PRODUCT_TOUR_REQUEST_EVENT, handleRequest);
    return () => window.removeEventListener(PRODUCT_TOUR_REQUEST_EVENT, handleRequest);
  }, [load]);

  return <>
    {error && <p role="alert" className="fixed bottom-4 right-4 z-[80] max-w-sm rounded-xl border bg-card p-4 text-sm shadow-lg">{error}</p>}
    {payload && <ProductTourDialog key={payload.tour_id ?? "workspace"} initialPayload={payload} open={open} onOpenChange={setOpen} />}
  </>;
}

export function ProductTourSettings(): React.ReactElement {
  const [payload, setPayload] = useState<ProductTourPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void requestJson<ApiEnvelope<ProductTourPayload>>("/api/onboarding/product-tour")
      .then((response) => setPayload(response.data))
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load tour status"));
  }, []);

  const status = payload?.state.status === "completed"
    ? "Completed"
    : payload?.state.status === "dismissed"
      ? "Skipped"
      : payload?.state.status === "in_progress"
        ? "In progress"
        : "Not started";

  return (
    <SettingsCard
      description="Take a one-minute tour of Home, Chat, Skills, Knowledge Bases, and personal settings."
      title={<span className="flex items-center gap-2"><GraduationCap className="h-5 w-5 text-primary" />Product tour</span>}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Status: {status}</p>
          <p className="mt-1 text-xs text-muted-foreground">Progress is saved to your account across browsers.</p>
          {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
        </div>
        <Button type="button" variant="outline" onClick={() => requestProductTour(true)}>
          <GraduationCap className="mr-2 h-4 w-4" />
          {payload?.state.status === "not_started" ? "Start tour" : "Replay tour"}
        </Button>
      </div>
    </SettingsCard>
  );
}
