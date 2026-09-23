import type { NextRequest } from "next/server";
import { changeAccess } from "@/lib/authz/access-http";

export const dynamic = "force-dynamic";
export const POST = (request: NextRequest) => changeAccess(request, "grant");
export const DELETE = (request: NextRequest) => changeAccess(request, "revoke");
