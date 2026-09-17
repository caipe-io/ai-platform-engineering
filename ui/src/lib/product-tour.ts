export const PRODUCT_TOUR_VERSION = 1;
export const PRODUCT_TOUR_REQUEST_EVENT = "caipe:product-tour-request";

export type ProductTourStatus =
  | "not_started"
  | "in_progress"
  | "completed"
  | "dismissed";

export interface ProductTourState {
  version: number;
  status: ProductTourStatus;
  current_step: number;
  started_at?: string;
  updated_at?: string;
  completed_at?: string;
  dismissed_at?: string;
  run_count: number;
}

export interface ProductTourPayload {
  auto_start: boolean;
  eligible: boolean;
  state: ProductTourState;
}

export const DEFAULT_PRODUCT_TOUR_STATE: ProductTourState = {
  version: PRODUCT_TOUR_VERSION,
  status: "not_started",
  current_step: 1,
  run_count: 0,
};

function timestamp(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

export function normalizeProductTourState(value: unknown): ProductTourState {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawStatus = source.status;
  const status: ProductTourStatus =
    rawStatus === "in_progress" || rawStatus === "completed" || rawStatus === "dismissed"
      ? rawStatus
      : "not_started";
  const rawStep = Number(source.current_step);
  const currentStep = Number.isInteger(rawStep)
    ? Math.min(5, Math.max(1, rawStep))
    : 1;
  const startedAt = timestamp(source.started_at);
  const updatedAt = timestamp(source.updated_at);
  const completedAt = timestamp(source.completed_at);
  const dismissedAt = timestamp(source.dismissed_at);

  return {
    version: PRODUCT_TOUR_VERSION,
    status,
    current_step: currentStep,
    run_count: Number.isInteger(source.run_count) && Number(source.run_count) >= 0
      ? Number(source.run_count)
      : 0,
    ...(startedAt ? { started_at: startedAt } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    ...(completedAt ? { completed_at: completedAt } : {}),
    ...(dismissedAt ? { dismissed_at: dismissedAt } : {}),
  };
}

export function requestProductTour(restart = false): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PRODUCT_TOUR_REQUEST_EVENT, {
    detail: { restart },
  }));
}
