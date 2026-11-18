import { NextRequest } from "next/server";
import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import {
  createModelConnection,
  listModelConnections,
  modelConnectionsRuntimeSupported,
} from "@/lib/server/model-connections";

async function actor(request: NextRequest) {
  const { user, session } = await getAuthFromBearerOrSession(request);
  if (
    ["skills_api_key", "catalog_api_key"].includes(session.principalType ?? "")
  )
    throw new ApiError("A user session is required", 403);
  return { session, email: user.email, name: user.name };
}
export const GET = withErrorHandler(async (request: NextRequest) => {
  const catalog = await listModelConnections(await actor(request));
  const response = successResponse({
    ...catalog,
    runtime_supported: await modelConnectionsRuntimeSupported(),
  });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
});
export const POST = withErrorHandler(async (request: NextRequest) => {
  const caller = await actor(request);
  const input = await request.json();
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ApiError("Connection configuration is required", 400);
  if (!(await modelConnectionsRuntimeSupported()))
    throw new ApiError(
      "Upgrade the Dynamic Agents runtime and configure its credential API before adding model connections.",
      409,
    );
  return successResponse(await createModelConnection(caller, input), 201);
});
