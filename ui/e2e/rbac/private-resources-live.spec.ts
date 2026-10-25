import { expect, test, type Page } from "@playwright/test";

import { rbacEnvOrSkip } from "./_env";
import { installTestSession } from "./_helpers";

async function jsonRequest(
  page: Page,
  path: string,
  init: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(async ({ path: requestPath, init: requestInit }) => {
    const response = await fetch(requestPath, requestInit);
    return {
      status: response.status,
      body: await response.json() as Record<string, unknown>,
    };
  }, { path, init });
}

test.describe("RBAC live e2e — private resources", () => {
  test("a private resource chain is manageable and authorized from the web UI", async ({ page }) => {
    const env = rbacEnvOrSkip({ requireUserSub: true });
    await installTestSession(page, env, {
      email: env.user.email,
      subject: env.user.sub!,
      role: "admin",
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const name = `Private E2E ${suffix}`;
    const agentId = `agent-private-e2e-${suffix}`;
    const mcpSlug = `private-e2e-${suffix}`;
    const mcpId = `mcp-${mcpSlug}`;
    let secretId = "";
    try {
      const secret = await jsonRequest(page, "/api/credentials/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Private E2E credential ${suffix}`,
          type: "api_key",
          value: `e2e-${suffix}`,
        }),
      });
      expect(secret.status, JSON.stringify(secret.body)).toBe(201);
      const secretData = secret.body.data as Record<string, unknown>;
      secretId = String(secretData.id ?? "");
      expect(secretId).not.toBe("");
      expect(secretData.visibility).toBe("private");

      const mcp = await jsonRequest(page, "/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: mcpSlug,
          name: `Private E2E MCP ${suffix}`,
          transport: "http",
          endpoint: "https://mcp.example.com/mcp",
          visibility: "private",
          credential_sources: [{
            kind: "secret_ref",
            target: "header",
            name: "X-CAIPE-Provider-Token",
            secret_ref: secretId,
          }],
        }),
      });
      expect(mcp.status, JSON.stringify(mcp.body)).toBe(201);
      expect((mcp.body.data as Record<string, unknown>)?.visibility).toBe("private");

      const created = await jsonRequest(page, "/api/dynamic-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          system_prompt: "Respond with a short test acknowledgement.",
          model: { id: "not-invoked", provider: "openai" },
          visibility: "private",
          allowed_tools: { [mcpId]: ["*"] },
        }),
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect((created.body.data as Record<string, unknown>)?.visibility).toBe("private");

      const listed = await jsonRequest(page, `/api/dynamic-agents?id=${agentId}`, { method: "GET" });
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);

      const webAgentUse = await jsonRequest(page, "/api/user/check_agent_access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId,
        }),
      });
      expect(webAgentUse.status, JSON.stringify(webAgentUse.body)).toBe(200);
      expect((webAgentUse.body.data as Record<string, unknown>)?.allowed).toBe(true);

      const webMcpUse = await jsonRequest(page, "/api/mcp-servers/agent-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverIds: [mcpId] }),
      });
      expect(webMcpUse.status, JSON.stringify(webMcpUse.body)).toBe(200);
      const webMcpData = webMcpUse.body.data as Record<string, unknown>;
      expect(webMcpData.server_ids).toEqual([mcpId]);
      expect(webMcpData.headers).toEqual(expect.objectContaining({
        "X-CAIPE-Agent-Context": expect.any(String),
        "X-CAIPE-Agent-Context-Signature": expect.any(String),
        "X-CAIPE-Trusted-Interaction": expect.any(String),
        "X-CAIPE-Trusted-Interaction-Signature": expect.any(String),
      }));

      const unsignedSlackAgentUse = await jsonRequest(page, "/api/user/check_agent_access", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Client-Source": "slack-bot",
        },
        body: JSON.stringify({ agent_id: agentId }),
      });
      expect(unsignedSlackAgentUse.status, JSON.stringify(unsignedSlackAgentUse.body)).toBe(200);
      expect(unsignedSlackAgentUse.body.data).toMatchObject({
        allowed: false,
        reason: "PRIVATE_RESOURCE_CONTEXT_DENIED",
      });

      const unsignedSlackMcpUse = await jsonRequest(page, "/api/mcp-servers/agent-context", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Client-Source": "slack-bot",
        },
        body: JSON.stringify({ serverIds: [mcpId] }),
      });
      expect(unsignedSlackMcpUse.status, JSON.stringify(unsignedSlackMcpUse.body)).toBe(403);

      await installTestSession(page, env, {
        email: "other-user@example.com",
        subject: `other-user-${suffix}`,
        role: "admin",
      });
      const outsiderAgentList = await jsonRequest(
        page,
        "/api/dynamic-agents?page=1&page_size=1000",
        { method: "GET" },
      );
      expect(outsiderAgentList.status, JSON.stringify(outsiderAgentList.body)).toBe(200);
      const outsiderItems = ((outsiderAgentList.body.data as Record<string, unknown>)?.items ?? []) as Array<{
        _id?: string;
      }>;
      expect(outsiderItems.some((item) => item._id === agentId)).toBe(false);

      const outsiderDirectRead = await jsonRequest(
        page,
        `/api/dynamic-agents/agents/${encodeURIComponent(agentId)}`,
        { method: "GET" },
      );
      expect(outsiderDirectRead.status, JSON.stringify(outsiderDirectRead.body)).toBe(404);

      const outsiderMcpList = await jsonRequest(
        page,
        "/api/mcp-servers?page=1&page_size=100",
        { method: "GET" },
      );
      expect(outsiderMcpList.status, JSON.stringify(outsiderMcpList.body)).toBe(200);
      const outsiderMcpItems = ((outsiderMcpList.body.data as Record<string, unknown>)?.items ?? []) as Array<{
        _id?: string;
      }>;
      expect(outsiderMcpItems.some((item) => item._id === mcpId)).toBe(false);

      const outsiderMcpDirectRead = await jsonRequest(
        page,
        `/api/mcp-servers?id=${encodeURIComponent(mcpId)}`,
        { method: "GET" },
      );
      expect(outsiderMcpDirectRead.status, JSON.stringify(outsiderMcpDirectRead.body)).toBe(404);

      const outsiderCredentialRead = await jsonRequest(
        page,
        `/api/credentials/secrets/${encodeURIComponent(secretId)}`,
        { method: "GET" },
      );
      expect([403, 404], JSON.stringify(outsiderCredentialRead.body)).toContain(outsiderCredentialRead.status);

      const outsiderAgentUse = await jsonRequest(page, "/api/user/check_agent_access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId }),
      });
      expect(outsiderAgentUse.status, JSON.stringify(outsiderAgentUse.body)).toBe(200);
      expect(outsiderAgentUse.body.data).toMatchObject({ allowed: false });

      const outsiderMcpUse = await jsonRequest(page, "/api/mcp-servers/agent-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverIds: [mcpId] }),
      });
      expect(outsiderMcpUse.status, JSON.stringify(outsiderMcpUse.body)).toBe(403);
    } finally {
      await installTestSession(page, env, {
        email: env.user.email,
        subject: env.user.sub!,
        role: "admin",
      }).catch(() => undefined);
      await jsonRequest(page, `/api/dynamic-agents?id=${encodeURIComponent(agentId)}`, {
        method: "DELETE",
      }).catch(() => undefined);
      await jsonRequest(page, `/api/mcp-servers?id=${encodeURIComponent(mcpId)}`, {
        method: "DELETE",
      }).catch(() => undefined);
      if (secretId) {
        await jsonRequest(page, `/api/credentials/secrets/${encodeURIComponent(secretId)}`, {
          method: "DELETE",
        }).catch(() => undefined);
      }
    }
  });
});
