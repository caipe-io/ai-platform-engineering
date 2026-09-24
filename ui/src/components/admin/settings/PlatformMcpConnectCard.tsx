"use client";

// assisted-by claude code claude-sonnet-5

import { AlertTriangle, Plug } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getConfig } from "@/lib/config";
import { cn } from "@/lib/utils";

/**
 * "Connect via MCP" — the inbound counterpart to MCPCatalogSettingsCard.
 *
 * MCPCatalogSettingsCard configures the external MCP servers CAIPE calls
 * out to. This card is the other direction: CAIPE's own Platform MCP
 * endpoint (`POST /api/mcp`, see the "CAIPE Platform/Admin MCP server"
 * proposal, discussions #2818 / PR #2819), which lets an MCP client read
 * this deployment as the signed-in user.
 *
 * No "mint an API token" path, by design — Platform MCP only supports
 * OAuth 2.0 Dynamic Client Registration + PKCE (RFC 9728 discovery,
 * RFC 7591 self-registration). A client authenticates as the signed-in
 * user; there is no separate long-lived token to generate, copy, or
 * revoke. See discussions #2818 for the full rationale.
 */

function originOf(): string {
  return typeof window !== "undefined"
    ? window.location.origin
    : "https://your-caipe-instance.example.com";
}

function CodeBlock({ text, label }: { text: string; label: string }) {
  return (
    <div className="relative rounded-md border bg-muted/40 p-3 pr-11 font-mono text-xs leading-relaxed">
      <pre className="overflow-x-auto whitespace-pre-wrap break-all">{text}</pre>
      <CopyButton value={text} label={`Copy ${label}`} className="absolute right-2 top-2" />
    </div>
  );
}

function ClaudeCodeTab({ endpoint }: { endpoint: string }) {
  const command = `claude mcp add --transport http caipe ${endpoint}`;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">Run once. Claude Code discovers CAIPE&apos;s OAuth settings and opens your browser to sign in.</p>
      <CodeBlock text={command} label="command" />
    </div>
  );
}

function ClaudeDesktopTab({ endpoint }: { endpoint: string }) {
  const config = JSON.stringify(
    {
      mcpServers: {
        caipe: {
          command: "npx",
          args: ["-y", "mcp-remote", endpoint, "--transport", "http-only"],
        },
      },
    },
    null,
    2,
  );
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Claude Desktop speaks stdio, not HTTP directly, so it bridges through{" "}
        <code className="rounded bg-muted px-1 py-0.5">mcp-remote</code>. Add this to your{" "}
        <code className="rounded bg-muted px-1 py-0.5">claude_desktop_config.json</code>, then
        restart Claude Desktop — it opens your browser to sign in on first use.
      </p>
      <CodeBlock text={config} label="config" />
    </div>
  );
}

function CursorTab({ endpoint }: { endpoint: string }) {
  const config = JSON.stringify({ mcpServers: { caipe: { url: endpoint } } }, null, 2);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Add this to <code className="rounded bg-muted px-1 py-0.5">~/.cursor/mcp.json</code> (or
        your project&apos;s <code className="rounded bg-muted px-1 py-0.5">.cursor/mcp.json</code>).
        Cursor connects over HTTP directly and opens your browser to sign in.
      </p>
      <CodeBlock text={config} label="config" />
    </div>
  );
}

function OtherClientTab({ endpoint }: { endpoint: string }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Any MCP client that supports Streamable HTTP can connect directly to this endpoint. It
        will receive a 401 with an RFC 9728{" "}
        <code className="rounded bg-muted px-1 py-0.5">resource_metadata</code> pointer on the
        first request and should follow it to discover the authorization server.
      </p>
      <CodeBlock text={endpoint} label="endpoint URL" />
    </div>
  );
}

const TEST_PROMPT = "Use only the CAIPE MCP server. List its tools, then call caipe_whoami once.";

function ConnectDialogBody({ endpoint }: { endpoint: string }) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Use CAIPE from Claude Code, Claude Desktop, Cursor, or another MCP client. Every option
        signs in as <em>you</em> via OAuth — there is no shared credential, and every tool call
        runs with your own CAIPE permissions.
      </p>

      <Tabs defaultValue="claude-code">
        <TabsList>
          <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
          <TabsTrigger value="claude-desktop">Claude Desktop</TabsTrigger>
          <TabsTrigger value="cursor">Cursor</TabsTrigger>
          <TabsTrigger value="other">Other client</TabsTrigger>
        </TabsList>
        <TabsContent value="claude-code" className="mt-3">
          <ClaudeCodeTab endpoint={endpoint} />
        </TabsContent>
        <TabsContent value="claude-desktop" className="mt-3">
          <ClaudeDesktopTab endpoint={endpoint} />
        </TabsContent>
        <TabsContent value="cursor" className="mt-3">
          <CursorTab endpoint={endpoint} />
        </TabsContent>
        <TabsContent value="other" className="mt-3">
          <OtherClientTab endpoint={endpoint} />
        </TabsContent>
      </Tabs>

      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
        <p className="text-sm font-medium">Check the connection</p>
        <p className="text-xs text-muted-foreground">
          Paste this into a fresh conversation with your client, after signing in.
        </p>
        <CodeBlock text={TEST_PROMPT} label="test prompt" />
      </div>

      <div className="grid gap-4 text-xs sm:grid-cols-2">
        <div>
          <p className="mb-1 font-medium text-emerald-600 dark:text-emerald-400">Working</p>
          <ul className="list-inside list-disc space-y-1 text-muted-foreground">
            <li>caipe shows connected in your client&apos;s MCP server list.</li>
            <li>
              Tools include <code className="rounded bg-muted px-1">caipe_whoami</code>,{" "}
              <code className="rounded bg-muted px-1">caipe_agent_list</code>, and{" "}
              <code className="rounded bg-muted px-1">caipe_agent_get</code>.
            </li>
            <li>caipe_whoami reports your own email and role, not a service account.</li>
          </ul>
        </div>
        <div>
          <p className="mb-1 font-medium text-destructive">Not working</p>
          <ul className="list-inside list-disc space-y-1 text-muted-foreground">
            <li>404: Platform MCP is disabled on this deployment — ask an admin to enable it.</li>
            <li>401 with no sign-in prompt: your client may not support the MCP OAuth flow yet.</li>
            <li>
              Stuck after signing in: dynamic client registration may not be enabled on the
              identity provider — ask an admin.
            </li>
            <li>No tools listed: reconnect the client; some clients cache an empty list.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export function PlatformMcpConnectCard({ readOnly = false }: { readOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const enabled = getConfig("platformMcpEnabled");
  const endpoint = `${originOf()}/api/mcp`;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Plug className="h-4 w-4" />
            Connect via MCP
            <Badge variant="secondary" className="text-[10px] font-normal">
              Phase 1: read-only
            </Badge>
          </CardTitle>
          <CardDescription>
            Let Claude Code, Claude Desktop, Cursor, or another MCP client read this CAIPE
            deployment as you — agents and their configuration, permission-filtered exactly like
            the web UI.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={!enabled || readOnly}
          onClick={() => setOpen(true)}
        >
          Connect via MCP
        </Button>
      </CardHeader>
      {!enabled && (
        <CardContent>
          <div
            className={cn(
              "flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm",
            )}
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <p className="text-muted-foreground">
              Platform MCP is disabled on this deployment. Set{" "}
              <code className="rounded bg-muted px-1 py-0.5">CAIPE_MCP_ENABLED=true</code> to
              enable it, then reload this page.
            </p>
          </div>
        </CardContent>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Connect via MCP</DialogTitle>
            <DialogDescription>
              Connect an MCP client to this CAIPE deployment ({endpoint}).
            </DialogDescription>
          </DialogHeader>
          <ConnectDialogBody endpoint={endpoint} />
        </DialogContent>
      </Dialog>
    </Card>
  );
}
