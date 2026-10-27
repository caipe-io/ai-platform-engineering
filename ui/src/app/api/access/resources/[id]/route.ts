import { NextRequest } from "next/server";
import { handleResource } from "@/lib/authz/resource-http";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleResource(request, "inspect", (await params).id);
}
