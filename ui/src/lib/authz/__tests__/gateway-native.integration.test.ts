/** @jest-environment node */
import { spawn, type ChildProcess } from "child_process";
import { generateKeyPairSync, randomUUID, sign } from "crypto";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "fs";
import { createServer, type Server } from "http";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { NextRequest } from "next/server";

import { checkGatewayAccess } from "../gateway-http";
import { signGatewayContext } from "../gateway-context";
import { __resetAdapterStateForTests } from "../engines/openfga";

jest.mock("@/lib/audit", () => ({ getAuditBackend: () => ({ write: () => {} }) }));

const binary = process.env.CAIPE_GATEWAY_TEST_BINARY;
const fgaUrl = process.env.OPENFGA_GATEWAY_TEST_URL;
const suite = binary && fgaUrl ? describe : describe.skip;
const credential = "test-native-gateway-credential-with-32-characters";
const caller = { type: "user" as const, id: "test-user" };
const originalEnv = { ...process.env };
const envKeys = ["OPENFGA_HTTP", "OPENFGA_STORE_ID", "CAIPE_GATEWAY_AUTHZ_TOKEN", "CAIPE_AGENT_CONTEXT_HMAC_SECRET",
  "CAIPE_RESTRICTED_MCP_SERVERS", "CAIPE_ORG_KEY", "AUDIT_FULL_FIDELITY_ALLOWS"];

suite("pinned gateway → real BFF handler → real chart-model OpenFGA → MCP", () => {
  let storeId: string;
  let server: Server;
  let gateway: ChildProcess;
  let base: string;
  let sessionId: string;
  let configPath: string;
  let directory: string;
  let gatewayLogs = "";
  let toolExecutions = 0;
  let permissionChecks = 0;
  let bffUnavailable = false;
  let bffSlow = false;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
  const tuple = { user: "user:test-user", relation: "user", object: "agent:example-agent" };
  const jwt = () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const input = `${encode({ alg: "RS256", kid: "test-key" })}.${encode({
      iss: "https://issuer.example.test", aud: "test-gateway", sub: caller.id,
      preferred_username: "test-user", iat: now, exp: now + 300,
    })}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
  };
  async function fga(path: string, body?: unknown, method = "POST") {
    const response = await fetch(fgaUrl + path, { method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Isolated OpenFGA: ${response.status} ${await response.text()}`);
    return response.status === 204 ? {} : response.json();
  }
  async function listen(listener: Server): Promise<number> {
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    return (listener.address() as { port: number }).port;
  }
  async function tool(headers: Record<string, string> = {}) {
    const context = signGatewayContext(caller, "example-agent");
    return fetch(base + "/mcp/example", { method: "POST", headers: {
      authorization: `Bearer ${jwt()}`, "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "x-caipe-agent-context": context.encoded, "x-caipe-agent-context-signature": context.signature, ...headers,
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_status", arguments: {} } }),
    signal: AbortSignal.timeout(10000) });
  }

  beforeAll(async () => {
    if (jest.isMockFunction(global.fetch)) throw new Error("Use jest.gateway.config.js for real HTTP");
    const url = new URL(fgaUrl!);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Loopback-only OpenFGA fixture required");
    storeId = (await fga("/stores", { name: `gateway-test-${randomUUID()}` })).id;
    await fga(`/stores/${storeId}/authorization-models`, JSON.parse(readFileSync(resolve(
      process.cwd(), "../charts/ai-platform-engineering/charts/openfga/authorization-model.json",
    ), "utf8")));
    await fga(`/stores/${storeId}/write`, { writes: { tuple_keys: [tuple,
      { user: "user:test-user", relation: "caller", object: "mcp_gateway:list" },
      { user: "agent:example-agent", relation: "caller", object: "tool:example/*" },
      { user: "user:test-user", relation: "caller", object: "tool:example/get_status" },
    ] } });
    process.env.OPENFGA_HTTP = fgaUrl;
    process.env.OPENFGA_STORE_ID = storeId;
    process.env.CAIPE_GATEWAY_AUTHZ_TOKEN = credential;
    process.env.CAIPE_AGENT_CONTEXT_HMAC_SECRET = "test-native-execution-key-with-32-characters";
    process.env.AUDIT_FULL_FIDELITY_ALLOWS = "true";
    delete process.env.CAIPE_RESTRICTED_MCP_SERVERS;
    delete process.env.CAIPE_ORG_KEY;
    __resetAdapterStateForTests();
    server = createServer(async (req, res) => {
      try {
        if (req.url === "/jwks") {
          res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString();
        if (req.url === "/api/access/gateway/check") {
          permissionChecks++;
          if (bffUnavailable) { res.writeHead(503, { "content-type": "application/json" }); res.end('{"error":"test BFF outage"}'); return; }
          if (bffSlow) {
            await new Promise((done) => setTimeout(done, 500));
            res.writeHead(200, { "content-type": "application/json" }); res.end('{"decision":"ALLOW"}'); return;
          }
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
          const response = await checkGatewayAccess(new NextRequest("http://localhost" + req.url, {
            method: req.method, headers, ...(req.method === "POST" ? { body } : {}),
          }));
          res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return;
        }
        const rpc = JSON.parse(body);
        if (rpc.method === "tools/call") toolExecutions++;
        if (rpc.id === undefined) { res.writeHead(204); res.end(); return; }
        const result = rpc.method === "initialize" ? {
          protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "example", version: "1" },
        } : rpc.method === "tools/list" ? { tools: [{ name: "get_status", description: "Example status", inputSchema: { type: "object" } }] } :
          { content: [{ type: "text", text: "example tool result" }] };
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      } catch (error) { res.writeHead(500); res.end(String(error)); }
    });
    const port = await listen(server);
    const reservation = createServer();
    const gatewayPort = await listen(reservation);
    await new Promise<void>((done) => reservation.close(() => done()));
    base = `http://127.0.0.1:${gatewayPort}`;
    directory = mkdtempSync(join(tmpdir(), "caipe-gateway-test-"));
    configPath = join(directory, "gateway.json");
    writeFileSync(configPath, JSON.stringify({
      binds: [{ port: gatewayPort, listeners: [{ protocol: "HTTP", policies: { jwtAuth: {
        mode: "strict", issuer: "https://issuer.example.test", audiences: ["test-gateway"], jwks: { url: `http://127.0.0.1:${port}/jwks` },
      } }, routes: [{ matches: [{ path: { pathPrefix: "/mcp/example" } }], policies: {
        extAuthz: { host: `127.0.0.1:${port}`, failureMode: { denyWithStatus: 503 },
          includeRequestHeaders: ["content-type", "x-caipe-agent-context", "x-caipe-agent-context-signature"],
          includeRequestBody: { maxRequestBytes: 65536, allowPartialMessage: false, packAsBytes: true },
          protocol: { http: { path: '"/api/access/gateway/check"', addRequestHeaders: {
            authorization: JSON.stringify(`Bearer ${credential}`), "x-caipe-caller-sub": "jwt.sub",
            "x-caipe-caller-username": 'default(jwt.preferred_username, "")', "x-caipe-mcp-path": "request.path",
          } } },
        }, authorization: { rules: [{ allow: "true" }] },
      }, backends: [{ mcp: { targets: [{ name: "example", mcp: { host: `http://127.0.0.1:${port}/mcp` } }] } }] }] }] }],
      config: { adminAddr: "127.0.0.1:0", statsAddr: "127.0.0.1:0", readinessAddr: "127.0.0.1:0" },
    }));
    gateway = spawn(binary!, ["--file", configPath], { env: { PATH: process.env.PATH, RUST_LOG: "warn" }, stdio: ["ignore", "pipe", "pipe"] });
    gateway.stdout?.on("data", (data) => { gatewayLogs += data; });
    gateway.stderr?.on("data", (data) => { gatewayLogs += data; });
    const deadline = Date.now() + 10000;
    for (;;) {
      try { if ((await fetch(base + "/mcp/example", { signal: AbortSignal.timeout(500) })).status === 401) break; } catch {}
      if (gateway.exitCode !== null || Date.now() > deadline) throw new Error(`Gateway did not start: ${gatewayLogs}`);
      await new Promise((done) => setTimeout(done, 50));
    }
    const initialization = await fetch(base + "/mcp/example", { method: "POST", headers: {
      authorization: `Bearer ${jwt()}`, "content-type": "application/json", accept: "application/json, text/event-stream",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "example", version: "1" },
    } }), signal: AbortSignal.timeout(10000) });
    const initializationBody = await initialization.text();
    const id = initialization.headers.get("mcp-session-id");
    if (initialization.status !== 200 || !id) throw new Error(`MCP initialization ${initialization.status}: ${initializationBody}\n${gatewayLogs}`);
    sessionId = id;
    permissionChecks = 0;
  }, 20000);

  afterAll(async () => {
    if (gateway && gateway.exitCode === null) {
      gateway.kill("SIGTERM"); await new Promise((done) => gateway.once("exit", done));
    }
    if (server) await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });
    if (storeId) await fga(`/stores/${storeId}`, undefined, "DELETE");
    if (configPath) unlinkSync(configPath);
    if (directory) rmdirSync(directory);
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
    }
    __resetAdapterStateForTests();
  }, 15000);

  it("executes only after a real complete CAS ALLOW", async () => {
    const response = await tool();
    const body = await response.text();
    if (response.status !== 200) throw new Error(`Gateway ${response.status}: ${body}\n${gatewayLogs}`);
    expect(toolExecutions).toBe(1);
    expect(permissionChecks).toBe(1);
  });
  it("overwrites forged caller/route assertions using verified JWT and actual path", async () => {
    expect((await tool({ "x-caipe-caller-sub": "secondary", "x-caipe-mcp-path": "/mcp/secondary" })).status).toBe(200);
  });
  it("rejects a missing context and never executes the tool", async () => {
    const before = toolExecutions;
    expect((await tool({ "x-caipe-agent-context": "", "x-caipe-agent-context-signature": "" })).status).toBe(403);
    expect(toolExecutions).toBe(before);
  });
  it("rejects an invalid JWT before asking the BFF", async () => {
    const before = permissionChecks;
    expect((await tool({ authorization: "Bearer invalid-user-token" })).status).toBe(401);
    expect(permissionChecks).toBe(before);
  });
  it("rejects a valid signature bound to another caller", async () => {
    const before = toolExecutions;
    const other = signGatewayContext({ type: "user", id: "secondary" }, "example-agent");
    const response = await tool({ "x-caipe-agent-context": other.encoded, "x-caipe-agent-context-signature": other.signature });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ failed_gate: "context" });
    expect(toolExecutions).toBe(before);
  });
  it("observes a real revoked agent grant on the next tool call", async () => {
    await fga(`/stores/${storeId}/write`, { deletes: { tuple_keys: [tuple] } });
    const before = toolExecutions;
    const response = await tool();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ failed_gate: "agent" });
    expect(toolExecutions).toBe(before);
    await fga(`/stores/${storeId}/write`, { writes: { tuple_keys: [tuple] } });
  });
  it("returns a BFF outage without executing or falling back to OpenFGA", async () => {
    bffUnavailable = true;
    const before = toolExecutions;
    expect((await tool()).status).toBe(503);
    expect(toolExecutions).toBe(before);
    bffUnavailable = false;
  });
  it("never forwards after the BFF authorization deadline expires", async () => {
    bffSlow = true;
    const before = toolExecutions;
    expect((await tool()).status).toBe(503);
    await new Promise((done) => setTimeout(done, 600));
    expect(toolExecutions).toBe(before);
    bffSlow = false;
  });
});
