"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingsCard } from "@/components/settings/shared/SettingsCard";
import {
  PRODUCT_TOUR_REQUEST_EVENT,
  requestProductTour,
  type ProductTourPayload,
  type ProductTourState,
} from "@/lib/product-tour";
import { cn } from "@/lib/utils";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Compass,
  GraduationCap,
  Loader2,
  MessageSquare,
  Settings,
  Sparkles,
  WandSparkles,
  Zap,
} from "lucide-react";
import { useRouter } from "next/navigation";
import React, { useCallback, useEffect, useState } from "react";

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  error?: string;
}

interface TourStep {
  description: string;
  eyebrow: string;
  icon: typeof Compass;
  points: string[];
  title: string;
}

const TOUR_STEPS: TourStep[] = [
  {
    eyebrow: "Welcome",
    title: "Your workspace is ready",
    description: "This quick tour shows the five places you will use most. It takes about a minute and is saved to your account.",
    icon: Sparkles,
    points: [
      "Start work from Home",
      "Collaborate with agents in Chat",
      "Reuse skills and trusted knowledge",
    ],
  },
  {
    eyebrow: "Home",
    title: "Pick up where you left off",
    description: "Home is your personal launchpad for recent conversations, suggested actions, and the work that matters now.",
    icon: Compass,
    points: [
      "Resume recent conversations",
      "Launch common workflows",
      "Customize the widgets you see",
    ],
  },
  {
    eyebrow: "Chat",
    title: "Work with the right agent",
    description: "Start a conversation, choose an available agent, and keep follow-up questions in the same thread so context carries forward.",
    icon: MessageSquare,
    points: [
      "Choose an agent for the task",
      "Attach files and invoke tools",
      "Review evidence before acting",
    ],
  },
  {
    eyebrow: "Skills & knowledge",
    title: "Reuse trusted building blocks",
    description: "Skills capture repeatable playbooks. Knowledge bases ground answers in sources you are allowed to access.",
    icon: Zap,
    points: [
      "Browse reusable skills",
      "Search approved knowledge",
      "Access remains permission-aware",
    ],
  },
  {
    eyebrow: "You are all set",
    title: "Make the workspace yours",
    description: "Use Settings to choose default agents, tune conversation behavior, and replay this tour whenever you need it.",
    icon: Settings,
    points: [
      "Set your preferred agents",
      "Adjust appearance and notifications",
      "Start with a real question in Chat",
    ],
  },
];

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

async function patchTour(action: string, currentStep?: number): Promise<ProductTourState> {
  const response = await requestJson<ApiEnvelope<{ state: ProductTourState }>>(
    "/api/onboarding/product-tour",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...(currentStep ? { current_step: currentStep } : {}) }),
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
  const router = useRouter();
  const [step, setStep] = useState(initialPayload?.state.current_step ?? 1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(initialPayload?.state.current_step ?? 1);
    if (initialPayload?.state.status === "not_started") {
      void patchTour("start", initialPayload.state.current_step).catch((reason) => {
        setError(reason instanceof Error ? reason.message : "Could not start the tour");
      });
    }
  }, [initialPayload, open]);

  const move = async (nextStep: number) => {
    setSaving(true);
    setError(null);
    try {
      await patchTour("progress", nextStep);
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
      await patchTour("dismiss", step);
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not dismiss the tour");
    } finally {
      setSaving(false);
    }
  };

  const complete = async () => {
    setSaving(true);
    setError(null);
    try {
      await patchTour("complete", TOUR_STEPS.length);
      onOpenChange(false);
      router.push("/chat");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not complete the tour");
    } finally {
      setSaving(false);
    }
  };

  const active = TOUR_STEPS[step - 1] ?? TOUR_STEPS[0];
  const Icon = active.icon;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen && !saving) void dismiss();
    }}>
      <DialogContent className="max-w-2xl overflow-hidden p-0">
        <div className="bg-gradient-to-br from-primary/15 via-background to-violet-500/10 px-6 pb-8 pt-7 sm:px-8">
          <div className="mb-7 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <GraduationCap className="h-4 w-4" /> Product tour
            </div>
            <span className="text-xs text-muted-foreground">{step} of {TOUR_STEPS.length}</span>
          </div>

          <div className="mb-7 flex gap-2" aria-label={`Tour step ${step} of ${TOUR_STEPS.length}`}>
            {TOUR_STEPS.map((tourStep, index) => (
              <span
                key={tourStep.eyebrow}
                className={cn(
                  "h-1.5 flex-1 rounded-full bg-border transition-colors",
                  index < step && "bg-primary",
                )}
              />
            ))}
          </div>

          <DialogHeader className="text-left">
            <div className="mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
              <Icon className="h-7 w-7" />
            </div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">{active.eyebrow}</p>
            <DialogTitle className="text-2xl sm:text-3xl">{active.title}</DialogTitle>
            <DialogDescription className="max-w-xl text-sm leading-6 sm:text-base">
              {active.description}
            </DialogDescription>
          </DialogHeader>

          <ul className="mt-6 grid gap-3 sm:grid-cols-3">
            {active.points.map((point) => (
              <li key={point} className="flex items-start gap-2 rounded-lg border bg-background/75 p-3 text-sm backdrop-blur">
                <span className="mt-0.5 rounded-full bg-primary/10 p-1 text-primary"><Check className="h-3 w-3" /></span>
                <span>{point}</span>
              </li>
            ))}
          </ul>

          {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="flex-row items-center justify-between border-t px-6 py-4 sm:justify-between sm:px-8">
          <Button type="button" variant="ghost" onClick={() => void dismiss()} disabled={saving}>
            Skip tour
          </Button>
          <div className="flex gap-2">
            {step > 1 && (
              <Button type="button" variant="outline" onClick={() => void move(step - 1)} disabled={saving}>
                <ChevronLeft className="mr-1 h-4 w-4" /> Back
              </Button>
            )}
            {step < TOUR_STEPS.length ? (
              <Button type="button" onClick={() => void move(step + 1)} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Next <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            ) : (
              <Button type="button" onClick={() => void complete()} disabled={saving}>
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <WandSparkles className="mr-2 h-4 w-4" />}
                Start chatting
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProductTourGate(): React.ReactElement | null {
  const [payload, setPayload] = useState<ProductTourPayload | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async (restart = false) => {
    try {
      if (restart) {
        const reset = await patchTour("reset");
        setPayload({ auto_start: true, eligible: true, state: reset });
        setOpen(true);
        return;
      }
      const response = await requestJson<ApiEnvelope<ProductTourPayload>>("/api/onboarding/product-tour");
      setPayload(response.data);
      setOpen(response.data.auto_start);
    } catch {
      // Product guidance must never block access to the application.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void requestJson<ApiEnvelope<ProductTourPayload>>("/api/onboarding/product-tour")
      .then((response) => {
        if (cancelled) return;
        setPayload(response.data);
        setOpen(response.data.auto_start);
      })
      .catch(() => {
        // Product guidance must never block access to the application.
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handleRequest = (event: Event) => {
      const restart = event instanceof CustomEvent && event.detail?.restart === true;
      void load(restart);
    };
    window.addEventListener(PRODUCT_TOUR_REQUEST_EVENT, handleRequest);
    return () => window.removeEventListener(PRODUCT_TOUR_REQUEST_EVENT, handleRequest);
  }, [load]);

  if (!payload) return null;
  return <ProductTourDialog initialPayload={payload} open={open} onOpenChange={setOpen} />;
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
