import { NextRequest } from "next/server";
import { handleDelegation } from "@/lib/authz/delegation-http";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, context: Context) {
  return handleDelegation(request, "inspect", (await context.params).id);
}
export async function DELETE(request: NextRequest, context: Context) {
  return handleDelegation(request, "revoke", (await context.params).id);
}
