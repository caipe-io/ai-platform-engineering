import {
  ApiError,
  successResponse,
  withAuth,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
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
}

interface ProductTourPatchBody {
  action?: unknown;
  current_step?: unknown;
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

function currentStep(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 5) {
    throw new ApiError("current_step must be between 1 and 5", 400, "INVALID_TOUR_STEP");
  }
  return Number(value);
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (_req, user) => {
    const platformConfig = await getCollection<PlatformConfigDocument>("platform_config");
    const [platform, settings] = await Promise.all([
      platformConfig.findOne({ _id: SETUP_WIZARD_CONFIG_ID }),
      getOrCreateUserSettings(user.email),
    ]);
    const setupState = normalizeSetupWizardState(platform?.setup_wizard);
    const state = normalizeProductTourState(settings.preferences?.product_tour);
    const eligible = setupState.status === "completed";

    return successResponse({
      auto_start: eligible && (state.status === "not_started" || state.status === "in_progress"),
      eligible,
      state,
    });
  });
});

export const PATCH = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (_req, user) => {
    const body = await request.json() as ProductTourPatchBody;
    const action = body.action;
    if (action !== "start" && action !== "progress" && action !== "dismiss" && action !== "complete" && action !== "reset") {
      throw new ApiError("action must be start, progress, dismiss, complete, or reset", 400, "INVALID_TOUR_ACTION");
    }

    const settings = await getCollection<UserSettings>("user_settings");
    const existing = await getOrCreateUserSettings(user.email);
    const previous = normalizeProductTourState(existing.preferences?.product_tour);
    const now = new Date().toISOString();
    const nextStep = currentStep(body.current_step);

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
        current_step: nextStep ?? previous.current_step,
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
          "preferences.product_tour": next,
          updated_at: new Date(now),
        },
      },
    );

    return successResponse({ state: next });
  });
});
