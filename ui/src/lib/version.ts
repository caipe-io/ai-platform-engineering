import fs from "fs";
import path from "path";

interface VersionInfo {
  version: string;
  gitCommit: string;
  buildDate: string;
  packageVersion?: string;
}

export function readVersionInfo(): VersionInfo {
    // Try to read version.json from public directory (built during Docker build)
    const versionPath = path.join(process.cwd(), "public", "version.json");

    let versionInfo: VersionInfo = {
      version: "dev",
      gitCommit: "unknown",
      buildDate: new Date().toISOString(),
    };

    if (fs.existsSync(versionPath)) {
      const versionData = fs.readFileSync(versionPath, "utf-8");
      versionInfo = JSON.parse(versionData);
    }

    // Also include package.json version for completeness
    const packagePath = path.join(process.cwd(), "package.json");
    if (fs.existsSync(packagePath)) {
      const packageData = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
      versionInfo.packageVersion = packageData.version;
    }

  return versionInfo;
}
