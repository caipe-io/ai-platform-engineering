import { checkGatewayAccess } from "@/lib/authz/gateway-http";

export const runtime = "nodejs";
export const POST = checkGatewayAccess;
export const GET = checkGatewayAccess;
export const DELETE = checkGatewayAccess;
// Override automatic successful HEAD/OPTIONS responses: only CAS may allow.
export const HEAD = checkGatewayAccess;
export const OPTIONS = checkGatewayAccess;
