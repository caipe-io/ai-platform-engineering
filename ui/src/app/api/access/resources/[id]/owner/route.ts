import { NextRequest } from "next/server";
import { handleResource } from "@/lib/authz/resource-http";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleResource(request, "transfer", (await params).id);
}
