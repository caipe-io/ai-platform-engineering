"use client";

import { Check, Copy, Eye, EyeOff } from "lucide-react";
import React, { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type { AutonomousTask } from "./types";

const PROVIDER_ISSUED_SECRETS = new Set(["slack", "pagerduty"]);

const PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  jira: "Jira",
  slack: "Slack",
  pagerduty: "PagerDuty",
};

function CopyValue({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [visible, setVisible] = useState(!secret);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // The selectable value remains available when clipboard permission is denied.
    }
  };

  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-input bg-muted/40 p-2">
        <code
          className="min-w-0 flex-1 select-all break-all text-xs"
          data-testid={`${label.toLowerCase().replaceAll(" ", "-")}-value`}
        >
          {visible ? value : `••••••••••••••••${value.slice(-4)}`}
        </code>
        {secret && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setVisible((current) => !current)}
            aria-label={visible ? "Hide signing secret" : "Show signing secret"}
          >
            {visible ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void copy()}
        >
          {copied ? (
            <Check className="mr-1 h-4 w-4" />
          ) : (
            <Copy className="mr-1 h-4 w-4" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

function ProviderInstructions({ provider }: { provider: string }) {
  if (provider === "github") {
    return (
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>
          Open the repository’s Settings → Webhooks and select Add webhook.
        </li>
        <li>
          Use the URL below as the Payload URL and select application/json.
        </li>
        <li>Copy the signing secret below into GitHub’s Secret field.</li>
        <li>
          Select the events that should run this task, keep Active enabled, and
          add the webhook.
        </li>
      </ol>
    );
  }
  if (provider === "jira") {
    return (
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Open Jira Settings → System → Webhooks and create a webhook.</li>
        <li>Use the URL below as the webhook URL.</li>
        <li>Copy the signing secret below into Jira’s Secret field.</li>
        <li>
          Choose the events that should run this task and save the webhook.
        </li>
      </ol>
    );
  }
  if (provider === "slack") {
    return (
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Open your Slack app’s Basic Information → App Credentials.</li>
        <li>
          Reveal and copy Slack’s Signing Secret, paste it below, and save it
          here.
        </li>
        <li>
          Use the URL below as the Request URL for the Slack feature that should
          run this task.
        </li>
      </ol>
    );
  }
  return (
    <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
      <li>
        Open PagerDuty Integrations → Generic Webhooks (v3) and select New
        Webhook.
      </li>
      <li>
        Use the URL below, choose the desired events, and add the webhook.
      </li>
      <li>
        Copy the secret shown by PagerDuty, paste it below, and save it here.
      </li>
    </ol>
  );
}

interface WebhookSetupStepProps {
  task: AutonomousTask;
  generatedSecret?: string;
  webhookUrl: string;
  onSaveProviderSecret: (secret: string) => Promise<void>;
  onDone: () => void;
}

export function WebhookSetupStep({
  task,
  generatedSecret,
  webhookUrl,
  onSaveProviderSecret,
  onDone,
}: WebhookSetupStepProps) {
  const provider =
    task.trigger.type === "webhook"
      ? (task.trigger.provider ?? "github")
      : "github";
  const providerLabel = PROVIDER_LABELS[provider] ?? provider;
  const providerIssuesSecret = PROVIDER_ISSUED_SECRETS.has(provider);
  const [providerSecret, setProviderSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveProviderSecret = async () => {
    if (!providerSecret.trim()) {
      setError(`${providerLabel} signing secret is required.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSaveProviderSecret(providerSecret.trim());
      setProviderSecret("");
      setSaved(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save signing secret.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="webhook-setup-step">
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200">
        Task created. Finish the {providerLabel} webhook setup below.
      </div>

      <ProviderInstructions provider={provider} />
      <CopyValue label="Webhook URL" value={webhookUrl} />

      {!providerIssuesSecret && generatedSecret && (
        <div className="space-y-2">
          <CopyValue label="Signing secret" value={generatedSecret} secret />
          <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
            Copy this secret now. It will not be shown again after you close
            this dialog.
          </p>
        </div>
      )}

      {!providerIssuesSecret && !generatedSecret && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          The one-time signing secret was not returned. Delete and recreate this
          task before configuring the webhook.
        </div>
      )}

      {providerIssuesSecret && !saved && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <Label htmlFor="provider-signing-secret">
            {providerLabel} signing secret
          </Label>
          <Input
            id="provider-signing-secret"
            type="password"
            autoComplete="off"
            value={providerSecret}
            onChange={(event) => setProviderSecret(event.target.value)}
            placeholder={`Paste the secret generated by ${providerLabel}`}
          />
          <p className="text-xs text-muted-foreground">
            Required. It is encrypted when stored and is never returned by the
            API.
          </p>
          <Button
            type="button"
            onClick={() => void saveProviderSecret()}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save signing secret"}
          </Button>
        </div>
      )}

      {saved && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-200">
          Signing secret saved securely.
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={onDone}
          disabled={
            (providerIssuesSecret && !saved) ||
            (!providerIssuesSecret && !generatedSecret)
          }
        >
          Done
        </Button>
      </div>
    </div>
  );
}
