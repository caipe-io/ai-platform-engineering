#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const mainScenePath = path.join(root, "docs/excalidraw/caipe-system-architecture.excalidraw");
const sourceScenePath = path.join(root, "docs/excalidraw/harness-engine-source-graph.excalidraw");
const imageDir = path.join(root, "docs/docs/architecture/images");
const systemSvgPath = path.join(imageDir, "harness-engine-system-architecture.svg");
const sourceSvgPath = path.join(imageDir, "harness-engine-source-graph.svg");

const PREFIX = "harness-engine-architecture-v1-";
const UPDATED = 1787200000000;
const COLORS = {
  ink: "#0f172a",
  muted: "#475569",
  line: "#64748b",
  panel: "#f8fafc",
  border: "#cbd5e1",
  blueFill: "#dbeafe",
  blue: "#2563eb",
  tealFill: "#ccfbf1",
  teal: "#0f766e",
  purpleFill: "#ede9fe",
  purple: "#7c3aed",
  greenFill: "#dcfce7",
  green: "#15803d",
  orangeFill: "#ffedd5",
  orange: "#c2410c",
  yellowFill: "#fef3c7",
  yellow: "#b45309",
  pinkFill: "#fce7f3",
  pink: "#be185d",
  grayFill: "#f1f5f9",
};

const system = {
  width: 3020,
  height: 2520,
  title: "Harness Engine — portable execution architecture",
  subtitle: "Implemented request, session, event, and adapter paths · dashed = planned or optional · Dynamic Agents remains unchanged",
  panels: [
    { id: "clients-panel", x: 40, y: 160, w: 500, h: 610, title: "CLIENTS & COMPATIBILITY APIs" },
    { id: "gateway-panel", x: 580, y: 160, w: 570, h: 610, title: "BFF HARNESS GATEWAY" },
    { id: "routing-panel", x: 1190, y: 160, w: 790, h: 610, title: "RUNTIME SELECTION" },
    { id: "control-panel", x: 40, y: 820, w: 1940, h: 870, title: "DURABLE HARNESS ENGINE CONTROL PLANE" },
    { id: "execution-panel", x: 2020, y: 820, w: 960, h: 870, title: "PROVIDER / EXECUTION PLANE" },
    { id: "services-panel", x: 40, y: 1740, w: 2940, h: 430, title: "PLATFORM SERVICES & PORTABLE INTERFACES" },
  ],
  nodes: [
    { id: "clients", x: 80, y: 230, w: 420, h: 110, title: "Web UI · CLI · Slack · Webex", body: "Existing clients and request contracts", fill: COLORS.blueFill, stroke: COLORS.blue },
    { id: "chat-routes", x: 80, y: 410, w: 420, h: 120, title: "Existing CAIPE chat APIs", body: "/api/v1/chat/{start, resume, cancel, invoke}", fill: COLORS.blueFill, stroke: COLORS.blue },
    { id: "authz", x: 80, y: 600, w: 420, h: 110, title: "Authentication + authorization", body: "JWT · agent#use · tenant · conversation", fill: COLORS.yellowFill, stroke: COLORS.yellow },

    { id: "marker", x: 620, y: 230, w: 490, h: 110, title: "Agent runtime marker", body: "execution_harness_id on BFF-owned agent config", fill: COLORS.grayFill, stroke: COLORS.line },
    { id: "gateway", x: 620, y: 410, w: 490, h: 140, title: "Harness Gateway", body: "Resolve runtime · enforce capabilities · no silent fallback", fill: COLORS.tealFill, stroke: COLORS.teal },
    { id: "translation", x: 620, y: 620, w: 490, h: 90, title: "Wire compatibility", body: "AG-UI / SSE · replay cursor · run ID", fill: COLORS.tealFill, stroke: COLORS.teal },

    { id: "dynamic-agents", x: 1230, y: 230, w: 710, h: 190, title: "LangChain Deep Agents", body: "Existing Dynamic Agents runtime\nMissing, dynamic_agents, or default marker\nExisting checkpoints, memory, tools, and streams", fill: COLORS.greenFill, stroke: COLORS.green, badge: "UNCHANGED DEFAULT" },
    { id: "harness-service", x: 1230, y: 500, w: 710, h: 200, title: "Harness Engine", body: "Independent FastAPI service\nAgentCore + Claude Agent SDK adapters\nDetached runs and durable canonical events", fill: COLORS.purpleFill, stroke: COLORS.purple, badge: "OPT-IN" },

    { id: "engine-api", x: 80, y: 900, w: 300, h: 120, title: "REST API", body: "catalog · validate · agents\nruns · events · sessions", fill: COLORS.purpleFill, stroke: COLORS.purple },
    { id: "coordinator", x: 450, y: 900, w: 330, h: 120, title: "RunCoordinator", body: "detached task ownership\nlifecycle + cancellation", fill: COLORS.purpleFill, stroke: COLORS.purple },
    { id: "sessions", x: 850, y: 900, w: 330, h: 120, title: "CAIPEAgentSessionManager", body: "owner binding · version pin\nepoch · clear", fill: COLORS.tealFill, stroke: COLORS.teal },
    { id: "registry", x: 1250, y: 900, w: 310, h: 120, title: "HarnessRegistry", body: "descriptors · validation\ncapability projection", fill: COLORS.tealFill, stroke: COLORS.teal },
    { id: "event-log", x: 1630, y: 900, w: 310, h: 120, title: "Canonical event log", body: "sequenced replay + live SSE\nrun lifecycle", fill: COLORS.blueFill, stroke: COLORS.blue },

    { id: "models", x: 80, y: 1120, w: 300, h: 130, title: "Portable contracts", body: "AgentBlueprint · RunContext\nHarnessDescriptor · CanonicalEvent", fill: COLORS.grayFill, stroke: COLORS.line },
    { id: "repository", x: 450, y: 1120, w: 330, h: 130, title: "Repository", body: "immutable agent versions\nsessions · runs · events", fill: COLORS.blueFill, stroke: COLORS.blue },
    { id: "provider-sessions", x: 850, y: 1120, w: 330, h: 130, title: "Provider session managers", body: "deterministic AgentCore IDs\nClaude resume session IDs", fill: COLORS.tealFill, stroke: COLORS.teal },
    { id: "adapter-contract", x: 1250, y: 1120, w: 310, h: 130, title: "HarnessAdapter boundary", body: "evaluate blueprint\nstream canonical events", fill: COLORS.purpleFill, stroke: COLORS.purple },
    { id: "encoder", x: 1630, y: 1120, w: 310, h: 130, title: "BFF event encoder", body: "canonical → AG-UI / SSE\nresponse accumulation", fill: COLORS.tealFill, stroke: COLORS.teal },

    { id: "brokers", x: 80, y: 1360, w: 710, h: 220, title: "Portable broker contracts", body: "Prompt · Tool · Thread State · Memory\nSandbox · Delegation · Telemetry · Limits\nProvider SDK types stop at the adapter boundary", fill: COLORS.grayFill, stroke: COLORS.line },
    { id: "durability", x: 850, y: 1360, w: 710, h: 220, title: "Disconnect-safe execution", body: "202 transfers execution ownership to Harness Engine\nSubscriber disconnect does not cancel the provider task\nReconnect replays events after the last cursor", fill: COLORS.blueFill, stroke: COLORS.blue },
    { id: "security", x: 1630, y: 1360, w: 310, h: 220, title: "Trust boundary", body: "Internal service token\nCaller identity remains at BFF\nNo user bearer token sent to provider", fill: COLORS.yellowFill, stroke: COLORS.yellow },

    { id: "agentcore", x: 2070, y: 900, w: 860, h: 140, title: "Amazon Bedrock AgentCore", body: "managed harness or custom runtime · deterministic runtimeSessionId\nprovider-native memory may be selected", fill: COLORS.orangeFill, stroke: COLORS.orange },
    { id: "claude", x: 2070, y: 1090, w: 860, h: 140, title: "Claude Agent SDK", body: "Bedrock-backed SDK profile · provider resume session ID\nMongo transcript mirror makes resume replica-independent", fill: COLORS.orangeFill, stroke: COLORS.orange },
    { id: "sandbox", x: 2070, y: 1280, w: 860, h: 160, title: "Kubernetes Agent Sandbox worker pods", body: "Planned: exclusive lease per session epoch · static operator profiles\nRuntimeClass + resource limits + default-deny egress + short-lived capabilities", fill: COLORS.pinkFill, stroke: COLORS.pink, dashed: true, badge: "PLANNED" },
    { id: "provider-boundary", x: 2070, y: 1490, w: 860, h: 130, title: "Provider-specific state stays behind adapters", body: "Provider SDK types and native state never enter the control-plane contract\nAll outward events use the canonical CAIPE lifecycle", fill: COLORS.grayFill, stroke: COLORS.line },

    { id: "mongo", x: 80, y: 1830, w: 400, h: 240, title: "MongoDB", body: "harness_agents + immutable versions\nharness_sessions · harness_runs\nharness_events · Claude transcripts", fill: COLORS.blueFill, stroke: COLORS.blue },
    { id: "mcp", x: 550, y: 1830, w: 400, h: 240, title: "AgentGateway + MCP", body: "Existing MCP servers\nOpenFGA ext_authz enforcement\nToolBroker target", fill: COLORS.greenFill, stroke: COLORS.green },
    { id: "memory", x: 1020, y: 1830, w: 400, h: 240, title: "Memory providers", body: "Portable MemoryBroker contract\nAgentCore memory may back Claude SDK\nsubject / agent / organization scopes", fill: COLORS.tealFill, stroke: COLORS.teal, dashed: true },
    { id: "telemetry", x: 1490, y: 1830, w: 400, h: 240, title: "Telemetry + audit", body: "W3C trace context · canonical events\nOpenTelemetry sink is planned\nExisting audit boundaries remain", fill: COLORS.yellowFill, stroke: COLORS.yellow, dashed: true },
    { id: "attachments", x: 1960, y: 1830, w: 400, h: 240, title: "Workspace + attachments", body: "Local / S3 abstraction target\nExplicitly unsupported by current adapters\nNo silent degradation", fill: COLORS.grayFill, stroke: COLORS.line, dashed: true },
    { id: "sandbox-api", x: 2430, y: 1830, w: 500, h: 240, title: "Agent Sandbox API", body: "SandboxClaim · warm pool · stable endpoint\nWorker protocol v1\nDesign complete; worker/lease code deferred", fill: COLORS.pinkFill, stroke: COLORS.pink, dashed: true },

    { id: "compat-note", x: 40, y: 2240, w: 900, h: 190, title: "Backward compatibility", body: "Existing agent IDs and chat endpoints are preserved.\nAgents without execution_harness_id remain on the unchanged\nDynamic Agents implementation of LangChain Deep Agents.", fill: COLORS.greenFill, stroke: COLORS.green },
    { id: "session-note", x: 1060, y: 2240, w: 900, h: 190, title: "Session and stream ownership", body: "The BFF stays horizontally stateless. Harness Engine owns\nprovider work, durable session bindings, run state, and replayable\nevents after returning 202.", fill: COLORS.blueFill, stroke: COLORS.blue },
    { id: "extension-note", x: 2080, y: 2240, w: 900, h: 190, title: "Extension contract", body: "New harnesses implement HarnessAdapter + ProviderSessionManager.\nPortable services can mix providers, for example Claude SDK\nwith AgentCore memory.", fill: COLORS.purpleFill, stroke: COLORS.purple },
  ],
  edges: [
    { from: "clients", to: "chat-routes", label: "same clients" },
    { from: "chat-routes", to: "authz", label: "authorize" },
    { from: "authz", to: "marker", label: "authorized agent" },
    { from: "marker", to: "gateway", label: "resolve" },
    { from: "gateway", to: "translation", label: "encode / replay" },
    { from: "gateway", to: "dynamic-agents", label: "default / legacy" },
    { from: "gateway", to: "harness-service", label: "agentcore / claude_sdk" },
    { from: "harness-service", to: "engine-api", label: "internal API" },
    { from: "engine-api", to: "coordinator" },
    { from: "coordinator", to: "sessions" },
    { from: "sessions", to: "registry" },
    { from: "coordinator", to: "repository" },
    { from: "coordinator", to: "provider-sessions" },
    { from: "registry", to: "adapter-contract" },
    { from: "coordinator", to: "event-log" },
    { from: "event-log", to: "encoder" },
    { from: "models", to: "coordinator" },
    { from: "adapter-contract", to: "agentcore" },
    { from: "adapter-contract", to: "claude" },
    { from: "adapter-contract", to: "sandbox", dashed: true, label: "future adapters" },
    { from: "provider-sessions", to: "provider-boundary" },
    { from: "repository", to: "mongo" },
    { from: "sessions", to: "mongo" },
    { from: "event-log", to: "mongo" },
    { from: "brokers", to: "mcp", label: "tools" },
    { from: "brokers", to: "memory", dashed: true, label: "memory" },
    { from: "brokers", to: "telemetry", dashed: true, label: "traces" },
    { from: "brokers", to: "attachments", dashed: true, label: "workspace" },
    { from: "brokers", to: "sandbox-api", dashed: true, label: "sandbox lease" },
  ],
};

const source = {
  width: 2600,
  height: 1860,
  title: "Harness Engine — high-level source graph",
  subtitle: "Dependency direction and source ownership in PR #2401 · paths are repository-relative",
  panels: [
    { id: "source-entry", x: 40, y: 150, w: 460, h: 820, title: "CHANNELS & ROUTES" },
    { id: "source-bff", x: 540, y: 150, w: 600, h: 820, title: "NEXT.JS BFF / HARNESS GATEWAY" },
    { id: "source-engine", x: 1180, y: 150, w: 780, h: 1240, title: "HARNESS ENGINE SERVICE" },
    { id: "source-provider", x: 2000, y: 150, w: 560, h: 1240, title: "ADAPTERS & INFRASTRUCTURE" },
    { id: "source-support", x: 40, y: 1430, w: 2520, h: 350, title: "DEPLOYMENT · CONTRACTS · TESTS" },
  ],
  nodes: [
    { id: "web-routes", x: 80, y: 230, w: 380, h: 160, title: "Public chat routes", body: "ui/src/app/api/v1/chat/\nstart · resume · cancel · invoke", fill: COLORS.blueFill, stroke: COLORS.blue },
    { id: "channel-routes", x: 80, y: 460, w: 380, h: 180, title: "Channel entry points", body: "ui/src/app/api/integrations/\nSlack · Webex\nScheduler / invoke callers", fill: COLORS.blueFill, stroke: COLORS.blue },
    { id: "agent-ui", x: 80, y: 710, w: 380, h: 180, title: "Agent creation + chat UX", body: "DynamicAgentEditor.tsx\nHarnessOptionsForm.tsx\nAgentSelector.tsx + harness badges", fill: COLORS.tealFill, stroke: COLORS.teal },

    { id: "gateway-source", x: 580, y: 230, w: 520, h: 170, title: "ui/src/lib/harness-gateway.ts", body: "runtime resolution · detached run orchestration\ncanonical event → AG-UI translation", fill: COLORS.tealFill, stroke: COLORS.teal },
    { id: "proxy-source", x: 580, y: 470, w: 520, h: 150, title: "harness-engine-proxy.ts", body: "internal service credential\nrequest and stream proxy", fill: COLORS.tealFill, stroke: COLORS.teal },
    { id: "session-client", x: 580, y: 680, w: 520, h: 150, title: "harness-engine-session-client.ts", body: "session clear / lifecycle client\nused by compatibility routes", fill: COLORS.tealFill, stroke: COLORS.teal },
    { id: "bff-routes", x: 580, y: 860, w: 520, h: 80, title: "ui/src/app/api/harness-engine/**", body: "authorized BFF administration + runtime proxy", fill: COLORS.grayFill, stroke: COLORS.line },

    { id: "main-source", x: 1220, y: 230, w: 330, h: 150, title: "main.py", body: "FastAPI routes\nstartup + internal auth", fill: COLORS.purpleFill, stroke: COLORS.purple },
    { id: "coordinator-source", x: 1590, y: 230, w: 330, h: 150, title: "coordinator.py", body: "detached tasks\nrun lifecycle + replay", fill: COLORS.purpleFill, stroke: COLORS.purple },
    { id: "models-source", x: 1220, y: 460, w: 330, h: 150, title: "models.py", body: "portable blueprints\ndescriptors · runs · events", fill: COLORS.grayFill, stroke: COLORS.line },
    { id: "registry-source", x: 1590, y: 460, w: 330, h: 150, title: "registry.py", body: "adapter catalog\nvalidation + fingerprints", fill: COLORS.tealFill, stroke: COLORS.teal },
    { id: "sessions-source", x: 1220, y: 690, w: 330, h: 170, title: "sessions.py", body: "CAIPEAgentSessionManager\nProviderSessionManager\nepoch + clear", fill: COLORS.tealFill, stroke: COLORS.teal },
    { id: "repo-source", x: 1590, y: 690, w: 330, h: 170, title: "repository.py", body: "memory + Mongo backends\nversions · bindings\nruns · ordered events", fill: COLORS.blueFill, stroke: COLORS.blue },
    { id: "brokers-source", x: 1220, y: 950, w: 700, h: 170, title: "brokers.py", body: "Protocols: Prompt · Tool · ThreadState · Memory · Sandbox\nDelegation · Telemetry · Limits", fill: COLORS.grayFill, stroke: COLORS.line },
    { id: "engine-config", x: 1220, y: 1190, w: 700, h: 140, title: "config.py + claude_session_store.py", body: "operator profile aliases · managed targets · Mongo transcript mirroring", fill: COLORS.grayFill, stroke: COLORS.line },

    { id: "base-adapter", x: 2040, y: 230, w: 480, h: 140, title: "adapters/base.py", body: "HarnessAdapter protocol · descriptor · evaluate · stream", fill: COLORS.purpleFill, stroke: COLORS.purple },
    { id: "agentcore-source", x: 2040, y: 440, w: 220, h: 190, title: "agentcore.py", body: "managed / custom\nsession IDs\ncanonical events", fill: COLORS.orangeFill, stroke: COLORS.orange },
    { id: "claude-source", x: 2300, y: 440, w: 220, h: 190, title: "claude_sdk.py", body: "SDK + Bedrock\nresume + mirror\ncanonical events", fill: COLORS.orangeFill, stroke: COLORS.orange },
    { id: "mongo-source", x: 2040, y: 720, w: 480, h: 150, title: "MongoDB collections", body: "agents · versions · sessions\nruns · events · Claude transcripts", fill: COLORS.blueFill, stroke: COLORS.blue },
    { id: "external-source", x: 2040, y: 950, w: 480, h: 170, title: "External execution dependencies", body: "AgentCore · Claude SDK / Bedrock\nAgentGateway / MCP\nfuture Agent Sandbox + OTel", fill: COLORS.greenFill, stroke: COLORS.green },

    { id: "deploy-source", x: 80, y: 1510, w: 560, h: 190, title: "Deployment", body: "docker-compose.harness-engine.yaml\nai_platform_engineering/harness_engine/build/Dockerfile\nenv.example + preview overlay", fill: COLORS.yellowFill, stroke: COLORS.yellow },
    { id: "docs-source", x: 710, y: 1510, w: 560, h: 190, title: "SpecKit + API contracts", body: "docs/docs/specs/2026-08-17-harness-engine/**\narchitecture · data model · REST · events\nsandbox · state / memory / tracing", fill: COLORS.grayFill, stroke: COLORS.line },
    { id: "tests-source", x: 1340, y: 1510, w: 560, h: 190, title: "Harness Engine tests", body: "adapter contract tests · registry validation\nsession managers · disconnect / replay E2E", fill: COLORS.greenFill, stroke: COLORS.green },
    { id: "ui-tests-source", x: 1970, y: 1510, w: 510, h: 190, title: "BFF + UI regression tests", body: "gateway routes · RBAC · agent editor\nlegacy default routing · picker + harness identity", fill: COLORS.greenFill, stroke: COLORS.green },
  ],
  edges: [
    { from: "web-routes", to: "gateway-source", label: "calls" },
    { from: "channel-routes", to: "gateway-source", label: "same gateway" },
    { from: "agent-ui", to: "bff-routes", label: "catalog + validation" },
    { from: "gateway-source", to: "proxy-source" },
    { from: "gateway-source", to: "session-client" },
    { from: "proxy-source", to: "main-source", label: "internal HTTP" },
    { from: "bff-routes", to: "main-source" },
    { from: "main-source", to: "coordinator-source" },
    { from: "coordinator-source", to: "models-source" },
    { from: "coordinator-source", to: "registry-source" },
    { from: "coordinator-source", to: "sessions-source" },
    { from: "coordinator-source", to: "repo-source" },
    { from: "coordinator-source", to: "brokers-source" },
    { from: "registry-source", to: "base-adapter" },
    { from: "base-adapter", to: "agentcore-source", axis: "vertical" },
    { from: "base-adapter", to: "claude-source", axis: "vertical" },
    { from: "sessions-source", to: "base-adapter" },
    { from: "repo-source", to: "mongo-source" },
    { from: "deploy-source", to: "main-source", dashed: true },
    { from: "docs-source", to: "models-source", dashed: true },
    { from: "tests-source", to: "coordinator-source", dashed: true },
    { from: "ui-tests-source", to: "gateway-source", dashed: true },
  ],
};

function hash(value) {
  let result = 2166136261;
  for (const char of value) {
    result ^= char.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return Math.abs(result) || 1;
}

function baseElement(id, type, x, y, width, height, order) {
  return {
    id: `${PREFIX}${id}`,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: COLORS.ink,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: `z${String(order).padStart(5, "0")}`,
    roundness: type === "text" ? null : { type: type === "arrow" ? 2 : 3 },
    seed: hash(`${id}-seed`),
    version: 1,
    versionNonce: hash(`${id}-nonce`),
    isDeleted: false,
    boundElements: [],
    updated: UPDATED,
    link: null,
    locked: false,
  };
}

function textElement(id, x, y, text, fontSize, color, order, options = {}) {
  const lines = text.split("\n");
  const width = Math.max(...lines.map((line) => line.length), 1) * fontSize * 0.56;
  const height = lines.length * fontSize * 1.25;
  return {
    ...baseElement(id, "text", x, y, width, height, order),
    strokeColor: color,
    strokeWidth: 1,
    fontSize,
    fontFamily: options.monospace ? 3 : 2,
    text,
    originalText: text,
    rawText: text,
    textAlign: options.align ?? "left",
    verticalAlign: "top",
    containerId: null,
    autoResize: true,
    lineHeight: 1.25,
  };
}

function rectElement(id, x, y, width, height, fill, stroke, order, dashed = false) {
  return {
    ...baseElement(id, "rectangle", x, y, width, height, order),
    strokeColor: stroke,
    backgroundColor: fill,
    strokeStyle: dashed ? "dashed" : "solid",
  };
}

function centerTextX(x, width, text, fontSize) {
  const longest = Math.max(...text.split("\n").map((line) => line.length), 1);
  return x + Math.max(16, (width - longest * fontSize * 0.56) / 2);
}

function edgePoints(from, to, edge = {}) {
  const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const horizontal = edge.axis
    ? edge.axis === "horizontal"
    : Math.abs(toCenter.x - fromCenter.x) >= Math.abs(toCenter.y - fromCenter.y);
  const start = horizontal
    ? { x: toCenter.x >= fromCenter.x ? from.x + from.w : from.x, y: fromCenter.y }
    : { x: fromCenter.x, y: toCenter.y >= fromCenter.y ? from.y + from.h : from.y };
  const end = horizontal
    ? { x: toCenter.x >= fromCenter.x ? to.x : to.x + to.w, y: toCenter.y }
    : { x: toCenter.x, y: toCenter.y >= fromCenter.y ? to.y : to.y + to.h };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const points = horizontal
    ? [[0, 0], [dx / 2, 0], [dx / 2, dy], [dx, dy]]
    : [[0, 0], [0, dy / 2], [dx, dy / 2], [dx, dy]];
  return { start, end, dx, dy, points };
}

function sceneElements(spec, offsetX = 0, offsetY = 0) {
  const elements = [];
  let order = 1;
  elements.push(textElement("title", offsetX + 40, offsetY + 35, spec.title, 42, COLORS.ink, order++));
  elements.push(textElement("subtitle", offsetX + 40, offsetY + 95, spec.subtitle, 20, COLORS.muted, order++));

  for (const panel of spec.panels) {
    elements.push(rectElement(`${panel.id}-frame`, offsetX + panel.x, offsetY + panel.y, panel.w, panel.h, COLORS.panel, COLORS.border, order++));
    elements.push(textElement(`${panel.id}-title`, offsetX + panel.x + 20, offsetY + panel.y + 18, panel.title, 16, COLORS.muted, order++));
  }

  const nodeById = new Map(spec.nodes.map((node) => [node.id, node]));
  for (const edge of spec.edges) {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) throw new Error(`Unknown edge endpoint: ${edge.from} -> ${edge.to}`);
    const geometry = edgePoints(from, to, edge);
    const absolutePoints = geometry.points.map(([x, y]) => [geometry.start.x + x, geometry.start.y + y]);
    const minX = Math.min(...absolutePoints.map(([x]) => x));
    const minY = Math.min(...absolutePoints.map(([, y]) => y));
    const maxX = Math.max(...absolutePoints.map(([x]) => x));
    const maxY = Math.max(...absolutePoints.map(([, y]) => y));
    const arrow = {
      ...baseElement(`edge-${edge.from}-${edge.to}`, "arrow", offsetX + minX, offsetY + minY, maxX - minX, maxY - minY, order++),
      strokeColor: edge.color ?? COLORS.line,
      strokeStyle: edge.dashed ? "dashed" : "solid",
      points: absolutePoints.map(([x, y]) => [x - minX, y - minY]),
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
    };
    elements.push(arrow);
    if (edge.label) {
      const labelX = offsetX + (geometry.start.x + geometry.end.x) / 2 - edge.label.length * 4;
      const labelY = offsetY + (geometry.start.y + geometry.end.y) / 2 - 22;
      elements.push(textElement(`edge-${edge.from}-${edge.to}-label`, labelX, labelY, edge.label, 13, COLORS.muted, order++));
    }
  }

  for (const node of spec.nodes) {
    const x = offsetX + node.x;
    const y = offsetY + node.y;
    const groupId = `${PREFIX}group-${node.id}`;
    const rect = rectElement(`node-${node.id}`, x, y, node.w, node.h, node.fill, node.stroke, order++, node.dashed);
    rect.groupIds = [groupId];
    elements.push(rect);
    const title = textElement(
      `node-${node.id}-title`,
      centerTextX(x, node.w, node.title, 19),
      y + 20,
      node.title,
      19,
      COLORS.ink,
      order++,
      { align: "center", monospace: node.title.includes(".") || node.title.includes("/") },
    );
    title.groupIds = [groupId];
    elements.push(title);
    const body = textElement(
      `node-${node.id}-body`,
      centerTextX(x, node.w, node.body, 14),
      y + 54,
      node.body,
      14,
      COLORS.muted,
      order++,
      { align: "center", monospace: node.body.includes("src/") },
    );
    body.groupIds = [groupId];
    elements.push(body);
    if (node.badge) {
      const badgeWidth = node.badge.length * 8 + 28;
      const badge = rectElement(`node-${node.id}-badge`, x + node.w - badgeWidth - 14, y + 12, badgeWidth, 27, "#ffffff", node.stroke, order++);
      badge.strokeWidth = 1;
      badge.groupIds = [groupId];
      elements.push(badge);
      const badgeText = textElement(`node-${node.id}-badge-text`, x + node.w - badgeWidth, y + 17, node.badge, 11, node.stroke, order++);
      badgeText.groupIds = [groupId];
      elements.push(badgeText);
    }
  }
  return elements;
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function svgText(x, y, text, size, color, options = {}) {
  const lines = text.split("\n");
  const anchor = options.center ? "middle" : "start";
  const weight = options.bold ? 700 : 400;
  const family = options.monospace ? "ui-monospace, SFMono-Regular, Menlo, monospace" : "Inter, ui-sans-serif, system-ui, sans-serif";
  const tspans = lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : size * 1.28}">${escapeXml(line)}</tspan>`).join("");
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${color}">${tspans}</text>`;
}

function renderSvg(spec) {
  const nodeById = new Map(spec.nodes.map((node) => [node.id, node]));
  const panels = spec.panels.map((panel) => `
    <rect x="${panel.x}" y="${panel.y}" width="${panel.w}" height="${panel.h}" rx="18" fill="${COLORS.panel}" stroke="${COLORS.border}" stroke-width="2"/>
    ${svgText(panel.x + 20, panel.y + 35, panel.title, 16, COLORS.muted, { bold: true })}`).join("");
  const edges = spec.edges.map((edge) => {
    const geometry = edgePoints(nodeById.get(edge.from), nodeById.get(edge.to), edge);
    const points = geometry.points.map(([x, y]) => `${geometry.start.x + x},${geometry.start.y + y}`).join(" ");
    const label = edge.label
      ? svgText((geometry.start.x + geometry.end.x) / 2, (geometry.start.y + geometry.end.y) / 2 - 9, edge.label, 13, COLORS.muted, { center: true })
      : "";
    return `<polyline points="${points}" fill="none" stroke="${edge.color ?? COLORS.line}" stroke-width="2.5" ${edge.dashed ? 'stroke-dasharray="10 8"' : ""} marker-end="url(#arrow)"/>${label}`;
  }).join("");
  const nodes = spec.nodes.map((node) => {
    const center = node.x + node.w / 2;
    const bodyLines = node.body.split("\n").length;
    const badgeWidth = node.badge ? node.badge.length * 8 + 28 : 0;
    const badge = node.badge ? `
      <rect x="${node.x + node.w - badgeWidth - 14}" y="${node.y + 12}" width="${badgeWidth}" height="27" rx="13.5" fill="#ffffff" stroke="${node.stroke}"/>
      ${svgText(node.x + node.w - badgeWidth / 2 - 14, node.y + 30, node.badge, 11, node.stroke, { center: true, bold: true })}` : "";
    return `
      <rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="14" fill="${node.fill}" stroke="${node.stroke}" stroke-width="2.5" ${node.dashed ? 'stroke-dasharray="11 8"' : ""}/>
      ${svgText(center, node.y + 34, node.title, 19, COLORS.ink, { center: true, bold: true, monospace: node.title.includes(".") || node.title.includes("/") })}
      ${svgText(center, node.y + 66, node.body, 14, COLORS.muted, { center: true, monospace: node.body.includes("src/") })}
      ${badge}
      ${bodyLines > 5 ? "" : ""}`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${spec.width} ${spec.height}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(spec.title)}</title>
  <desc id="desc">${escapeXml(spec.subtitle)}</desc>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${COLORS.line}"/></marker>
  </defs>
  <rect width="${spec.width}" height="${spec.height}" fill="#ffffff"/>
  ${svgText(40, 65, spec.title, 42, COLORS.ink, { bold: true })}
  ${svgText(40, 110, spec.subtitle, 20, COLORS.muted)}
  ${panels}
  ${edges}
  ${nodes}
</svg>\n`.replace(/[ \t]+$/gm, "");
}

function writeScene(scenePath, spec, elements) {
  fs.writeFileSync(scenePath, `${JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements,
    appState: {
      gridSize: 20,
      gridStep: 5,
      gridModeEnabled: false,
      viewBackgroundColor: "#ffffff",
      lockedMultiSelections: {},
    },
    files: {},
  }, null, 2)}\n`);
}

const mainScene = JSON.parse(fs.readFileSync(mainScenePath, "utf8"));
mainScene.elements = mainScene.elements.filter((element) => !element.id.startsWith(PREFIX));
mainScene.elements.push(...sceneElements(system, -330, 5840));
fs.writeFileSync(mainScenePath, `${JSON.stringify(mainScene, null, 2)}\n`);

writeScene(sourceScenePath, source, sceneElements(source));
fs.mkdirSync(imageDir, { recursive: true });
fs.writeFileSync(systemSvgPath, renderSvg(system));
fs.writeFileSync(sourceSvgPath, renderSvg(source));

console.log(`Updated ${path.relative(root, mainScenePath)}`);
console.log(`Created ${path.relative(root, sourceScenePath)}`);
console.log(`Created ${path.relative(root, systemSvgPath)}`);
console.log(`Created ${path.relative(root, sourceSvgPath)}`);
