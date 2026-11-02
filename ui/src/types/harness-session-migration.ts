export interface HarnessSessionMigrationStatus {
  state: "available" | "busy" | "recoverable" | "managed" | "unavailable";
}
