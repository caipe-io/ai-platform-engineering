"use client";

// assisted-by Codex Codex-sonnet-4-6

import React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { SaveButton } from "@/components/admin/shared/SaveButton";
import { shortMaskedPreview } from "@/lib/credentials/masking";
import { Button } from "@/components/ui/button";

import { principalLabel, SecretProtectionBadge } from "./SecretProtectionDetails";

interface SecretActorRef {
  type: "user" | "service_account";
  id: string;
  email?: string;
  name?: string;
  displayName?: string;
}

interface ActorRef {
  type: string;
  id: string;
  email?: string;
  name?: string;
  displayName?: string;
}

interface SecretUsageReference {
  type: "mcp_server" | "llm_provider";
  id: string;
  name: string;
  location: string;
  detail?: string;
}

interface SecretStorageMetadata {
  metadataCollection: string;
  payloadCollection: string;
  encryption: string;
  plaintextReadableByBrowser: false;
  valuePreviewAvailable: true;
}

interface AdminSecretMetadata {
  id: string;
  name: string;
  description?: string;
  type: string;
  owner: { type: string; id: string; email?: string; name?: string; displayName?: string };
  createdBy?: SecretActorRef;
  maskedPreview: string;
  sharedWithTeams?: string[];
  usage?: SecretUsageReference[];
  storage?: SecretStorageMetadata;
  createdAt?: string;
  updatedAt?: string;
  rotatedAt?: string;
}

interface CredentialAuditEvent {
  action: string;
  result?: string;
  outcome?: string;
  ts?: string;
  resource?: { id?: string; type?: string };
  resource_ref?: string;
  actor?: ActorRef;
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const json = (await response.json()) as { data: T };
  return json.data;
}

function formatDate(value?: string): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return date.toLocaleString();
}

function auditMatchesSecret(event: CredentialAuditEvent, secretId: string): boolean {
  return event.resource?.id === secretId || event.resource_ref === `secret_ref:${secretId}`;
}

function auditResultLabel(event: CredentialAuditEvent): string {
  return event.result ?? event.outcome ?? "recorded";
}

function auditActionLabel(action: string): string {
  switch (action) {
    case "credential.create":
      return "Secret added";
    case "credential.rotate":
      return "Secret rotated";
    case "credential.update":
      return "Details updated";
    case "credential.share":
      return "Team access granted";
    case "credential.revoke":
      return "Team access removed";
    case "credential.delete":
      return "Secret deleted";
    default:
      return action.replace(/^credential\./, "").replace(/\./g, " ");
  }
}

function friendlyResultLabel(event: CredentialAuditEvent): string {
  const result = auditResultLabel(event);
  if (result === "success") return "Completed";
  if (result === "allow") return "Allowed";
  if (result === "deny") return "Denied";
  return result;
}

function actorSummary(actor?: ActorRef | SecretActorRef): string {
  return principalLabel(actor, {
    fallback: "Not recorded",
    userIdFallback: "Unknown user",
  });
}

function teamAccessSummary(teamCount: number): string {
  if (teamCount === 0) return "Private";
  return `Shared with ${teamCount} ${teamCount === 1 ? "team" : "teams"}`;
}

function usageSummary(usageCount: number): string {
  if (usageCount === 0) return "No linked services";
  return `Used in ${usageCount} ${usageCount === 1 ? "place" : "places"}`;
}

export function AdminSecretsManager({ readOnly = false }: { readOnly?: boolean }) {
  const [secrets, setSecrets] = React.useState<AdminSecretMetadata[]>([]);
  const [auditEvents, setAuditEvents] = React.useState<CredentialAuditEvent[]>([]);
  const [editingSecret, setEditingSecret] = React.useState<AdminSecretMetadata | null>(null);
  const [editName, setEditName] = React.useState("");
  const [editDescription, setEditDescription] = React.useState("");
  const [expandedSecretId, setExpandedSecretId] = React.useState<string | null>(null);
  const [confirmingDeleteSecretId, setConfirmingDeleteSecretId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const loadSecrets = React.useCallback(async () => {
    setError(null);
    const [secretsResponse, auditResponse] = await Promise.all([
      fetch("/api/admin/credentials/secrets"),
      fetch("/api/admin/credentials/audit"),
    ]);
    if (!secretsResponse.ok) {
      setError("Could not load global secrets");
      return;
    }
    setSecrets(await parseApiResponse<AdminSecretMetadata[]>(secretsResponse));
    if (auditResponse.ok) {
      setAuditEvents(await parseApiResponse<CredentialAuditEvent[]>(auditResponse));
    } else {
      setAuditEvents([]);
    }
  }, []);

  React.useEffect(() => {
    void loadSecrets();
  }, [loadSecrets]);

  async function deleteSecret(secretId: string) {
    if (readOnly) return;
    const response = await fetch(`/api/admin/credentials/secrets/${secretId}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      setError("Could not delete secret");
      return;
    }
    setSecrets((current) => current.filter((secret) => secret.id !== secretId));
    setConfirmingDeleteSecretId(null);
  }

  function openEdit(secret: AdminSecretMetadata) {
    if (readOnly) return;
    setEditingSecret(secret);
    setEditName(secret.name);
    setEditDescription(secret.description ?? "");
  }

  async function saveEdit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (readOnly || !editingSecret) return;
    const response = await fetch(`/api/admin/credentials/secrets/${editingSecret.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: editName, description: editDescription }),
    });
    if (!response.ok) {
      setError("Could not update secret");
      return;
    }
    const updated = await parseApiResponse<AdminSecretMetadata>(response);
    setSecrets((current) => current.map((secret) => (secret.id === updated.id ? updated : secret)));
    setEditingSecret(null);
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Secrets</h2>
        <p className="text-sm text-muted-foreground">
          Review saved secrets, access, and usage. Open details for audit and protection info.
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {secrets.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No secrets found.</p>
        ) : (
          <ul className="divide-y divide-border">
            {secrets.map((secret) => {
              const usage = secret.usage ?? [];
              const sharedWithTeams = secret.sharedWithTeams ?? [];
              const storage = secret.storage;
              const matchingAuditEvents = auditEvents
                .filter((event) => auditMatchesSecret(event, secret.id))
                .slice(0, 3);
              const expanded = expandedSecretId === secret.id;
              const confirmingDelete = confirmingDeleteSecretId === secret.id;

              return (
                <li key={secret.id} className="p-3">
                  <div className="grid items-center gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_auto]">
                    <div className="min-w-0">
                      <div>
                        <p className="truncate font-medium">{secret.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{secret.description || secret.type}</p>
                      </div>
                      <code className="mt-1 inline-flex max-w-full rounded bg-muted px-2 py-1 text-xs">
                        <span className="truncate">Preview {shortMaskedPreview(secret.maskedPreview)}</span>
                      </code>
                    </div>

                    <div className="min-w-0 text-sm">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Created</p>
                      <p className="truncate">{actorSummary(secret.createdBy)}</p>
                      <p className="truncate text-xs text-muted-foreground">{formatDate(secret.createdAt)}</p>
                    </div>

                    <div className="min-w-0 text-sm">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Shared with</p>
                      <p className="truncate">{teamAccessSummary(sharedWithTeams.length)}</p>
                      <p className="truncate text-xs text-muted-foreground">{usageSummary(usage.length)}</p>
                    </div>

                    <div className="flex flex-wrap gap-2 md:justify-end">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        aria-expanded={expanded}
                        aria-controls={`secret-details-${secret.id}`}
                        onClick={() => setExpandedSecretId((current) => (current === secret.id ? null : secret.id))}
                      >
                        {expanded ? (
                          <ChevronDown className="mr-1 h-4 w-4" aria-hidden="true" />
                        ) : (
                          <ChevronRight className="mr-1 h-4 w-4" aria-hidden="true" />
                        )}
                        {expanded ? "Hide details" : "More details"}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => openEdit(secret)}
                        disabled={readOnly}
                      >
                        Edit
                      </Button>
                      {confirmingDelete ? (
                        <>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => setConfirmingDeleteSecretId(null)}
                          >
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            aria-label={`Confirm delete ${secret.name}`}
                            onClick={() => void deleteSecret(secret.id)}
                          >
                            Confirm delete
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          aria-label={`Delete ${secret.name}`}
                          onClick={() => setConfirmingDeleteSecretId(secret.id)}
                          disabled={readOnly}
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                  </div>

                  {expanded && (
                    <div
                      id={`secret-details-${secret.id}`}
                      className="mt-3 grid gap-3 rounded-md border border-border/60 bg-background/50 p-3 text-sm md:grid-cols-3"
                    >
                      <div className="space-y-2">
                        <p className="font-medium">Created by</p>
                        <div className="space-y-1 text-xs text-muted-foreground">
                          <p>{actorSummary(secret.createdBy)}</p>
                          <p>Created {formatDate(secret.createdAt)}</p>
                          <p>Last rotated {formatDate(secret.rotatedAt)}</p>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <p className="font-medium">Shared with</p>
                        <div className="flex flex-wrap gap-1">
                          {sharedWithTeams.length > 0 ? (
                            sharedWithTeams.map((teamId) => (
                              <span key={teamId} className="rounded-full bg-teal-500/10 px-2 py-0.5 text-xs text-teal-300">
                                {teamId}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-muted-foreground">Only the owner can use it</span>
                          )}
                        </div>
                        <div className="space-y-1">
                          {usage.length > 0 ? (
                            usage.map((item) => (
                              <p key={`${item.type}:${item.id}:${item.detail ?? ""}`} className="text-xs text-muted-foreground">
                                {item.name} · {item.location}
                                {item.detail ? ` · ${item.detail}` : ""}
                              </p>
                            ))
                          ) : (
                            <p className="text-xs text-muted-foreground">No linked services yet</p>
                          )}
                        </div>
                      </div>

                      <div className="space-y-2">
                        <p className="font-medium">Protection</p>
                        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                          <span>Value and masked preview are encrypted.</span>
                          <SecretProtectionBadge storage={storage} />
                        </div>
                      </div>

                      <div className="md:col-span-3">
                        <p className="mb-2 font-medium">Recent activity</p>
                        {matchingAuditEvents.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No recent activity yet.</p>
                        ) : (
                          <ul className="space-y-2">
                            {matchingAuditEvents.map((event, index) => (
                              <li
                                key={`${event.action}-${event.ts ?? index}`}
                                className="grid gap-2 text-xs text-muted-foreground md:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_auto]"
                              >
                                <span className="truncate font-medium text-foreground">{auditActionLabel(event.action)}</span>
                                <span className="truncate">{actorSummary(event.actor)}</span>
                                <span className="flex items-center gap-2 md:justify-end">
                                  <span className="rounded bg-muted px-2 py-0.5 text-foreground">
                                    {friendlyResultLabel(event)}
                                  </span>
                                  <span>{formatDate(event.ts)}</span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {editingSecret && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Edit Secret"
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
        >
          <form
            onSubmit={(event) => void saveEdit(event)}
            className="w-full max-w-xl rounded-lg border border-border bg-card p-5 shadow-xl space-y-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-medium">Edit Secret</h2>
                <p className="text-sm text-muted-foreground">
                  Update the name and description only. The secret value stays protected.
                </p>
              </div>
              <button type="button" className="text-sm text-muted-foreground" onClick={() => setEditingSecret(null)}>
                Close
              </button>
            </div>
            <label className="space-y-1 text-sm block">
              <span>Name</span>
              <input
                className="w-full rounded-md border border-input bg-background px-3 py-2"
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
                required
              />
            </label>
            <label className="space-y-1 text-sm block">
              <span>Description</span>
              <input
                className="w-full rounded-md border border-input bg-background px-3 py-2"
                value={editDescription}
                onChange={(event) => setEditDescription(event.target.value)}
              />
            </label>
            <SaveButton type="submit" saving={false} ariaLabel="Save changes" />
          </form>
        </div>
      )}
    </section>
  );
}
