import { getCollection } from "@/lib/mongodb";
import { PLATFORM_CONFIG_ID } from "@/lib/platform-default-agent";

interface PlatformProjectsDocument {
  _id: string;
  projects?: { enabled?: unknown };
}

export function projectsEnabledFromEnvironment(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.PROJECTS_ENABLED?.trim() || "");
}

export async function getProjectsEnabled(): Promise<boolean> {
  const collection = await getCollection<PlatformProjectsDocument>("platform_config");
  const document = await collection.findOne({ _id: PLATFORM_CONFIG_ID });
  const configured = document?.projects?.enabled;
  return typeof configured === "boolean" ? configured : projectsEnabledFromEnvironment();
}
