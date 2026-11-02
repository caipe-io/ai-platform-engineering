import { NextResponse } from "next/server";
import { readVersionInfo } from "@/lib/version";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const versionInfo = readVersionInfo();
    return NextResponse.json(versionInfo);
  } catch (error) {
    console.error("Error reading version info:", error);
    return NextResponse.json(
      {
        version: "unknown",
        gitCommit: "unknown",
        buildDate: new Date().toISOString(),
        error: "Failed to read version info",
      },
      { status: 500 }
    );
  }
}
