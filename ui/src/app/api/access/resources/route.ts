import { NextRequest } from "next/server";
import { handleResource } from "@/lib/authz/resource-http";

export const POST = (request: NextRequest) => handleResource(request, "register");
