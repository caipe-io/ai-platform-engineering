import { NextRequest } from "next/server";
import { handleDelegation } from "@/lib/authz/delegation-http";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return handleDelegation(request, "check", (await context.params).id);
}
