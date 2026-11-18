import { NextRequest } from "next/server";
import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { assertCredentialServiceCaller } from "@/lib/credentials/internal-caller";
import { resolveModelPlan } from "@/lib/server/model-connections";

/** Raw provider material is available exclusively over the existing server credential boundary. */
export const POST = withErrorHandler(async (request: NextRequest) => {
  assertCredentialServiceCaller({
    headers: request.headers,
    expectedAudience:
      process.env.CREDENTIAL_SERVICE_AUDIENCE || "caipe-credential-service",
  });
  const { user, session } = await getAuthFromBearerOrSession(request);
  if (
    ["skills_api_key", "catalog_api_key"].includes(session.principalType ?? "")
  )
    throw new ApiError("Scoped credentials cannot resolve models", 403);
  const body = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiError("Invalid model resolution request", 400);
  const response = successResponse(
    await resolveModelPlan(
      { session, email: user.email, name: user.name },
      request.headers,
      body,
    ),
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
});
