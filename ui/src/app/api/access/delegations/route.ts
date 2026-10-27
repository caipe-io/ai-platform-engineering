import { NextRequest } from "next/server";
import { handleDelegation } from "@/lib/authz/delegation-http";

export const runtime = "nodejs";
export function POST(request: NextRequest) { return handleDelegation(request, "create"); }
