import { normalizeEnabledTours } from "@/lib/caipe-tour-policy";
import {
  ApiError,
  successResponse,
  withAuth,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getServerConfig } from "@/lib/config";
import { getCollection } from "@/lib/mongodb";
import { PRODUCT_TOURS, isProductTourId, type ProductTourId } from "@/lib/product-tour-catalog";
import {
  DEFAULT_PRODUCT_TOUR_STATE,
  normalizeProductTourState,
  PRODUCT_TOUR_VERSION,
  type ProductTourState,
} from "@/lib/product-tour";
import {
  normalizeSetupWizardState,
  SETUP_WIZARD_CONFIG_ID,
} from "@/lib/setup-wizard";
import {
  DEFAULT_USER_SETTINGS,
  type UserSettings,
} from "@/types/mongodb";
import type { Document } from "mongodb";
import { NextRequest } from "next/server";

interface PlatformConfigDocument extends Document {
  _id: string;
  setup_wizard?: unknown;
  caipe_tour?: { enabled_tours?: unknown };
}

interface ProductTourPatchBody {
  action?: unknown;
  tour_id?: unknown;
  current_step?: unknown;
  enabled?: unknown;
}

async function getOrCreateUserSettings(userEmail: string): Promise<UserSettings> {
  const settings = await getCollection<UserSettings>("user_settings");
  const doc = await settings.findOneAndUpdate(
    { user_id: userEmail },
    {
      $setOnInsert: {
        user_id: userEmail,
        ...DEFAULT_USER_SETTINGS,
        updated_at: new Date(),
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  if (!doc) throw new ApiError("Could not initialize tour preferences", 500, "TOUR_SETTINGS_UNAVAILABLE");
  return doc;
}

function tourId(value: unknown): ProductTourId {
  if (value === undefined || value === null) return "workspace";
  if (!isProductTourId(value)) throw new ApiError("Unknown tour", 400, "INVALID_TOUR_ID");
  return value;
}

function savedState(settings: UserSettings, id: ProductTourId): ProductTourState {
  return normalizeProductTourState(id === "workspace"
    ? settings.preferences?.product_tour
    : settings.preferences?.task_tours?.[id], id);
}

function currentStep(value: unknown, id: ProductTourId): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > PRODUCT_TOURS[id].steps.length) {
    throw new ApiError(`current_step must be between 1 and ${PRODUCT_TOURS[id].steps.length}`, 400, "INVALID_TOUR_STEP");
  }
  return Number(value);
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (_req, user) => {
    const id = tourId(_req.nextUrl.searchParams.get("tour"));
    const platformConfig = await getCollection<PlatformConfigDocument>("platform_config");
    const [platform, settings] = await Promise.all([
      platformConfig.findOne({ _id: SETUP_WIZARD_CONFIG_ID }),
      getOrCreateUserSettings(user.email),
    ]);
    const eligible = id !== "workspace" || normalizeSetupWizardState(platform?.setup_wizard).status === "completed";
    const state = savedState(settings, id);
    const enabledTours = normalizeEnabledTours(platform?.caipe_tour?.enabled_tours);
    const toursEnabled = settings.preferences?.caipe_tour_enabled !== false;
    const enabled = toursEnabled && enabledTours.includes(id);
    return successResponse({
      tour_id: id,
      enabled,
      tours_enabled: toursEnabled,
      enabled_tours: enabledTours,
      auto_start: enabled && id === "workspace" && getServerConfig().setupWizardEnabled && eligible && (state.status === "not_started" || state.status === "in_progress"),
      eligible,
      state,
    });
  });
});

export const PATCH = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (_req, user) => {
    const body = await request.json() as ProductTourPatchBody;
    const id = tourId(body.tour_id);
    const action = body.action;
    if (action !== "start" && action !== "progress" && action !== "dismiss" && action !== "complete" && action !== "reset" && action !== "set_enabled") {
      throw new ApiError("action must be start, progress, dismiss, complete, reset, or set_enabled", 400, "INVALID_TOUR_ACTION");
    }

    const nextStep = currentStep(body.current_step, id);
    if (action === "set_enabled" && typeof body.enabled !== "boolean") throw new ApiError("enabled must be a boolean", 400, "INVALID_TOUR_PREFERENCE");
    const platformConfig = await getCollection<PlatformConfigDocument>("platform_config");
    const [platform, existing] = await Promise.all([
      platformConfig.findOne({ _id: SETUP_WIZARD_CONFIG_ID }),
      getOrCreateUserSettings(user.email),
    ]);
    const enabledTours = normalizeEnabledTours(platform?.caipe_tour?.enabled_tours);
    const settings = await getCollection<UserSettings>("user_settings");
    if (action === "set_enabled") {
      await settings.updateOne({ user_id: user.email }, { $set: { "preferences.caipe_tour_enabled": body.enabled, updated_at: new Date() } });
      return successResponse({ tour_id: id, enabled: body.enabled && enabledTours.includes(id), tours_enabled: body.enabled, enabled_tours: enabledTours, auto_start: false, eligible: true, state: savedState(existing, id) });
    }
    if (existing.preferences?.caipe_tour_enabled === false || !enabledTours.includes(id)) {
      throw new ApiError("This CAIPE Tour is disabled", 403, "TOUR_DISABLED");
    }
    const previous = savedState(existing, id);
    const now = new Date().toISOString();

    let next: ProductTourState;
    if (action === "reset") {
      next = {
        ...DEFAULT_PRODUCT_TOUR_STATE,
        status: "in_progress",
        started_at: now,
        updated_at: now,
        run_count: previous.run_count + 1,
      };
    } else {
      next = {
        ...previous,
        version: PRODUCT_TOUR_VERSION,
        status: action === "complete"
          ? "completed"
          : action === "dismiss"
            ? "dismissed"
            : "in_progress",
        current_step: action === "complete" ? PRODUCT_TOURS[id].steps.length : nextStep ?? previous.current_step,
        started_at: previous.started_at ?? now,
        updated_at: now,
        ...(action === "complete" ? { completed_at: now } : {}),
        ...(action === "dismiss" ? { dismissed_at: now } : {}),
        run_count: Math.max(1, previous.run_count),
      };
    }

    await settings.updateOne(
      { user_id: user.email },
      {
        $set: {
          [id === "workspace" ? "preferences.product_tour" : `preferences.task_tours.${id}`]: next,
          updated_at: new Date(now),
        },
      },
    );

    return successResponse({ tour_id: id, state: next, enabled: true, tours_enabled: true, enabled_tours: enabledTours });
  });
});
