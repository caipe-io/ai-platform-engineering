"use client";

// assisted-by claude code claude-sonnet-4-6
// assisted-by Codex Codex-sonnet-4-6

import dagre from "@dagrejs/dagre";
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleSlash,
  Database,
  GitBranch,
  Hash,
  Layers,
  ListChecks,
  MessageSquare,
  Settings,
  Shield,
  Maximize2,
  Minimize2,
  User,
  Users,
  Wrench,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  Background,
  BackgroundVariant,
  Handle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CAIPESpinner } from "@/components/ui/caipe-spinner";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AgentPicker } from "@/components/ui/agent-picker";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { RebacGraphFilters, subjectPrefix, type RebacGraphUserOption } from "../rebac/RebacGraphFilters";

type GraphLayer = "tuples" | "effective" | "model";
type ExplorerMode = "relationships" | "feature-check";
type FeatureKind = "invoke_agent" | "agent_call_tool" | "agent_use_rag" | "agent_use_skill";
type FeatureCheckStatus = "allowed" | "blocked" | "unknown" | "not_enforced" | "skipped";

interface GraphNode {
  id: string;
  label: string;
  type: string;
}

interface GraphEdge {
  id: string;
  from: string;
  to: string;
  relation: string;
  status?: FeatureCheckStatus;
  kind?: "openfga" | "metadata" | "effective" | "model";
  layer?: "tuples" | "metadata" | "effective" | "model";
  metadata?: {
    source_type: "slack_channel_team_mapping" | "webex_space_team_mapping";
    label: string;
    readonly: true;
  };
}


interface RebacNodeData {
  label: string;
  kind: string;
  object: string;
  description?: string;
  [key: string]: unknown;
}

interface RebacEdgeData {
  metadata?: GraphEdge["metadata"];
  [key: string]: unknown;
}

interface FlowNodeDefinition {
  id: string;
  label: string;
  kind: string;
  object?: string;
  items?: string[];
}

interface FeatureResourceOption {
  id: string;
  label: string;
  type: string;
  relation?: string;
}

interface FeatureCheckStep {
  id: string;
  label: string;
  status: FeatureCheckStatus;
  subject: string;
  relation: string;
  object: string;
  detail: string;
  missingGrant?: string;
}

interface FeatureCheckResult {
  decision: "allow" | "deny" | "partial" | "unknown";
  headline: string;
  subline: string;
  steps: FeatureCheckStep[];
  missingGrants: string[];
  featureGraph: { nodes: GraphNode[]; edges: GraphEdge[] };
}

function apiData<T>(payload: { data?: T } & T): T {
  return (payload.data ?? payload) as T;
}

function nodeKind(object: string): string {
  if (object.includes("#")) return "userset";
  const [type] = object.split(":");
  return type || "unknown";
}

const GRAPH_KIND_META: Record<string, { label: string; icon: LucideIcon; className: string }> = {
  user: { label: "User", icon: User, className: "border-sky-400 bg-sky-500/10" },
  user_profile: { label: "User Profile", icon: User, className: "border-sky-400 bg-sky-500/10" },
  team: { label: "Team", icon: Shield, className: "border-violet-400 bg-violet-500/10" },
  userset: { label: "Userset", icon: Users, className: "border-indigo-400 bg-indigo-500/10" },
  admin_surface: { label: "Admin Surface", icon: Shield, className: "border-fuchsia-400 bg-fuchsia-500/10" },
  agent: { label: "Agent", icon: Bot, className: "border-emerald-400 bg-emerald-500/10" },
  mcp_gateway: { label: "AgentGateway", icon: Wrench, className: "border-amber-400 bg-amber-500/10" },
  mcp_server: { label: "MCP Server", icon: Wrench, className: "border-amber-400 bg-amber-500/10" },
  tool: { label: "Tool", icon: Wrench, className: "border-amber-400 bg-amber-500/10" },
  knowledge_base: { label: "Knowledge Base", icon: Database, className: "border-rose-400 bg-rose-500/10" },
  data_source: { label: "Data Source", icon: Database, className: "border-rose-400 bg-rose-500/10" },
  slack_channel: { label: "Slack Channel", icon: Hash, className: "border-cyan-400 bg-cyan-500/10" },
  webex_space: { label: "Webex Space", icon: MessageSquare, className: "border-violet-400 bg-violet-500/10" },
  llm_model: { label: "LLM Model", icon: Zap, className: "border-blue-400 bg-blue-500/10" },
  mcp_tool: { label: "MCP Tool", icon: Wrench, className: "border-orange-400 bg-orange-500/10" },
  skill: { label: "Skill", icon: Layers, className: "border-teal-400 bg-teal-500/10" },
  conversation: { label: "Conversation", icon: MessageSquare, className: "border-cyan-400 bg-cyan-500/10" },
  secret_ref: { label: "Credential", icon: Shield, className: "border-fuchsia-400 bg-fuchsia-500/10" },
  system_config: { label: "System Config", icon: Settings, className: "border-slate-400 bg-slate-500/10" },
  model_resource_type: { label: "Model Type", icon: Database, className: "border-blue-400 bg-blue-500/10" },
  model_relation: { label: "Model Relation", icon: GitBranch, className: "border-amber-400 bg-amber-500/10" },
  model_permission: { label: "Model Permission", icon: Shield, className: "border-emerald-400 bg-emerald-500/10" },
  model_relation_stack: { label: "Relation Stack", icon: GitBranch, className: "border-amber-400 bg-amber-500/10" },
  model_permission_stack: { label: "Permission Stack", icon: Shield, className: "border-emerald-400 bg-emerald-500/10" },
};

function graphKindMeta(kind: string) {
  return GRAPH_KIND_META[kind] ?? {
    label: kind.replace(/_/g, " ") || "Resource",
    icon: Database,
    className: "border-border bg-card",
  };
}

// ── Effective-access card helpers ─────────────────────────────────────────

const RESOURCE_CARD_META: Record<string, { label: string; icon: LucideIcon; className: string }> = {
  agent: { label: "Agent", icon: Bot, className: "border-emerald-400 bg-emerald-500/10" },
  mcp_gateway: { label: "AgentGateway", icon: Wrench, className: "border-amber-400 bg-amber-500/10" },
  mcp_server: { label: "MCP Server", icon: Wrench, className: "border-amber-400 bg-amber-500/10" },
  tool: { label: "Tool", icon: Wrench, className: "border-amber-400 bg-amber-500/10" },
  knowledge_base: { label: "Knowledge Base", icon: Database, className: "border-rose-400 bg-rose-500/10" },
  data_source: { label: "Data Source", icon: Database, className: "border-rose-400 bg-rose-500/10" },
  admin_surface: { label: "Admin Surface", icon: Shield, className: "border-fuchsia-400 bg-fuchsia-500/10" },
  slack_channel: { label: "Slack Channel", icon: Hash, className: "border-cyan-400 bg-cyan-500/10" },
  webex_space: { label: "Webex Space", icon: MessageSquare, className: "border-violet-400 bg-violet-500/10" },
  llm_model: { label: "LLM Model", icon: Zap, className: "border-blue-400 bg-blue-500/10" },
  mcp_tool: { label: "MCP Tool", icon: Wrench, className: "border-orange-400 bg-orange-500/10" },
  skill: { label: "Skill", icon: Layers, className: "border-teal-400 bg-teal-500/10" },
  conversation: { label: "Conversation", icon: MessageSquare, className: "border-cyan-400 bg-cyan-500/10" },
  secret_ref: { label: "Credential", icon: Shield, className: "border-fuchsia-400 bg-fuchsia-500/10" },
  system_config: { label: "System Config", icon: Settings, className: "border-slate-400 bg-slate-500/10" },
};

const RESOURCE_TYPE_ORDER = [
  "agent", "mcp_gateway", "mcp_server", "tool", "mcp_tool", "knowledge_base", "data_source",
  "skill", "llm_model", "conversation", "secret_ref", "admin_surface", "slack_channel", "webex_space",
];

const SYSTEM_NODE_TYPES = new Set([
  "user", "team", "userset", "user_profile",
  "model_resource_type", "model_relation", "model_permission",
]);

function resourceCardMeta(type: string) {
  return RESOURCE_CARD_META[type] ?? {
    label: type.replace(/_/g, " "),
    icon: Database,
    className: "border-border bg-card",
  };
}

interface ResourceGrant { relation: string; via: string; }
interface ResourceAccess { node: GraphNode; grants: ResourceGrant[]; }

function parseVia(from: string): string {
  const m = /^team:([^#]+)#(member|admin)$/.exec(from);
  if (m) return `via ${m[1]} ${m[2]}s`;
  if (/^team:[^#]+$/.test(from)) return "direct team";
  if (from.startsWith("user:") || from.startsWith("service_account:")) return "direct";
  return from;
}

function buildAccessMap(graph: { nodes: GraphNode[]; edges: GraphEdge[] }): Map<string, ResourceAccess> {
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const accessMap = new Map<string, ResourceAccess>();
  for (const edge of graph.edges) {
    if (edge.kind !== "effective") continue;
    const target = nodeMap.get(edge.to);
    if (!target || SYSTEM_NODE_TYPES.has(target.type)) continue;
    const via = parseVia(edge.from);
    const existing = accessMap.get(edge.to);
    if (existing) {
      if (!existing.grants.some((g) => g.relation === edge.relation && g.via === via)) {
        existing.grants.push({ relation: edge.relation, via });
      }
    } else {
      accessMap.set(edge.to, { node: target, grants: [{ relation: edge.relation, via }] });
    }
  }
  return accessMap;
}

function groupAccessByType(accessMap: Map<string, ResourceAccess>): Map<string, ResourceAccess[]> {
  const grouped = new Map<string, ResourceAccess[]>();
  for (const access of accessMap.values()) {
    const type = access.node.type;
    const list = grouped.get(type) ?? [];
    list.push(access);
    grouped.set(type, list);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => a.node.label.localeCompare(b.node.label));
  }
  return grouped;
}

function sortedAccessGroupEntries(grouped: Map<string, ResourceAccess[]>): [string, ResourceAccess[]][] {
  return [...grouped.entries()].sort(([a], [b]) => {
    const ai = RESOURCE_TYPE_ORDER.indexOf(a);
    const bi = RESOURCE_TYPE_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

const ACTOR_ENTITY_KINDS = new Set(["user", "team", "service_account", "unlinked_service_account"]);
const RESOURCE_ENTITY_KINDS = new Set([
  "agent",
  "skill",
  "knowledge_base",
  "data_source",
  "conversation",
  "secret_ref",
  "llm_model",
]);

function graphUserLabel(user: RebacGraphUserOption): string {
  if (user.kind === "team") return user.name ?? user.slug ?? user.id;
  if (user.kind === "unlinked_service_account") return user.name ?? "Unlinked service account";
  if (user.kind && RESOURCE_ENTITY_KINDS.has(user.kind)) return user.name ?? user.id;
  if (user.id === "*") return "user:*";
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.email || user.username || user.id;
}

function isActorEntity(entity: RebacGraphUserOption | null): entity is RebacGraphUserOption {
  if (!entity) return false;
  return !entity.kind || ACTOR_ENTITY_KINDS.has(entity.kind);
}

function isResourceEntity(entity: RebacGraphUserOption | null): entity is RebacGraphUserOption {
  if (!entity?.kind) return false;
  return RESOURCE_ENTITY_KINDS.has(entity.kind);
}

function graphEntitySubjectRef(entity: RebacGraphUserOption): string {
  const id = entity.kind === "team" ? entity.slug ?? entity.id : entity.id;
  return `${subjectPrefix(entity)}:${id}`;
}

function graphEntityResourceScope(entity: RebacGraphUserOption): { type: string; id: string } {
  return {
    type: subjectPrefix(entity),
    id: entity.kind === "team" ? entity.slug ?? entity.id : entity.id,
  };
}

const FEATURE_OPTIONS: Array<{ value: FeatureKind; label: string; targetLabel: string }> = [
  { value: "invoke_agent", label: "Invoke agent", targetLabel: "Agent" },
  { value: "agent_call_tool", label: "Use agent with MCP/tool", targetLabel: "MCP / tool" },
  { value: "agent_use_rag", label: "Use agent with Knowledge Base / RAG", targetLabel: "KB / RAG resource" },
  { value: "agent_use_skill", label: "Use agent with skill", targetLabel: "Skill" },
];

const FEATURE_STATUS_META: Record<FeatureCheckStatus, { label: string; className: string; icon: LucideIcon }> = {
  allowed: { label: "Allowed", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300", icon: CheckCircle2 },
  blocked: { label: "Blocked", className: "border-red-500/40 bg-red-500/10 text-red-300", icon: XCircle },
  unknown: { label: "Unknown", className: "border-amber-500/40 bg-amber-500/10 text-amber-300", icon: AlertTriangle },
  not_enforced: { label: "Not FGA enforced", className: "border-slate-500/40 bg-slate-500/10 text-slate-300", icon: CircleSlash },
  skipped: { label: "Skipped", className: "border-border bg-muted/40 text-muted-foreground", icon: CircleSlash },
};

const FEATURE_RESOURCE_TYPES: Record<FeatureKind, string[]> = {
  invoke_agent: [],
  agent_call_tool: ["tool", "mcp_tool", "mcp_server"],
  agent_use_rag: ["knowledge_base", "data_source", "organization"],
  agent_use_skill: ["skill"],
};

const FEATURE_RESOURCE_RELATIONS: Record<FeatureKind, string[]> = {
  invoke_agent: [],
  agent_call_tool: ["can_call", "can_use", "can_invoke"],
  agent_use_rag: ["can_read", "can_search", "can_use", "can_ingest"],
  agent_use_skill: ["can_use", "can_invoke", "can_call"],
};

function objectType(ref: string): string {
  return ref.split(":", 1)[0] || "unknown";
}

function objectId(ref: string): string {
  return ref.split(":").slice(1).join(":");
}

function nodeLabel(graph: { nodes: GraphNode[] }, ref: string): string {
  return graph.nodes.find((node) => node.id === ref)?.label ?? ref;
}

function effectiveResourceOptions(input: {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] } | null;
  source?: string | null;
  types: string[];
  relations?: string[];
}): FeatureResourceOption[] {
  const { graph, source, types, relations } = input;
  if (!graph) return [];
  const typeSet = new Set(types);
  const relationSet = relations ? new Set(relations) : null;
  const options = new Map<string, FeatureResourceOption>();
  for (const edge of graph.edges) {
    if (edge.kind !== "effective") continue;
    if (source && edge.from !== source) continue;
    const type = objectType(edge.to);
    if (!typeSet.has(type)) continue;
    if (relationSet && !relationSet.has(edge.relation)) continue;
    const existing = options.get(edge.to);
    if (existing) {
      existing.relation = existing.relation ?? edge.relation;
      continue;
    }
    options.set(edge.to, {
      id: edge.to,
      label: nodeLabel(graph, edge.to),
      type,
      relation: edge.relation,
    });
  }
  return [...options.values()].sort((left, right) => {
    const typeOrder = RESOURCE_TYPE_ORDER.indexOf(left.type) - RESOURCE_TYPE_ORDER.indexOf(right.type);
    if (RESOURCE_TYPE_ORDER.includes(left.type) && RESOURCE_TYPE_ORDER.includes(right.type) && typeOrder !== 0) {
      return typeOrder;
    }
    return left.label.localeCompare(right.label);
  });
}

function findEffectiveEdge(input: {
  graph: { edges: GraphEdge[] } | null;
  source?: string | null;
  target?: string | null;
  targetTypes?: string[];
  relations: string[];
}): GraphEdge | null {
  const { graph, source, target, targetTypes, relations } = input;
  if (!graph) return null;
  const relationSet = new Set(relations);
  const typeSet = targetTypes ? new Set(targetTypes) : null;
  return graph.edges.find((edge) => {
    if (edge.kind !== "effective") return false;
    if (source && edge.from !== source) return false;
    if (target && edge.to !== target) return false;
    if (typeSet && !typeSet.has(objectType(edge.to))) return false;
    return relationSet.has(edge.relation);
  }) ?? null;
}

function viaLabel(graph: { edges: GraphEdge[] }, target: string, rawRelations: string[]): string {
  const rawRelationSet = new Set(rawRelations);
  const raw = graph.edges.find((edge) => edge.kind !== "effective" && edge.to === target && rawRelationSet.has(edge.relation));
  return raw ? parseVia(raw.from) : "effective access";
}

function statusDecision(steps: FeatureCheckStep[]): FeatureCheckResult["decision"] {
  if (steps.some((step) => step.status === "blocked")) return "deny";
  if (steps.some((step) => step.status === "unknown")) return "unknown";
  if (steps.some((step) => step.status === "not_enforced")) return "partial";
  return "allow";
}

function suggestedToolGrant(agentRef: string, resourceRef?: string | null): string {
  if (!resourceRef) return `${agentRef} can_call tool:<server>/*`;
  const type = objectType(resourceRef);
  if (type === "mcp_server") return `${agentRef} can_call tool:${objectId(resourceRef)}/*`;
  return `${agentRef} can_call ${resourceRef}`;
}

function buildFeatureCheckResult(input: {
  feature: FeatureKind;
  actor: RebacGraphUserOption | null;
  actorRef: string | null;
  agentRef: string | null;
  selectedResourceRef: string;
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  agentGraph: { nodes: GraphNode[]; edges: GraphEdge[] } | null;
  agentGraphLoading: boolean;
  agentGraphError: string | null;
}): FeatureCheckResult {
  const { feature, actor, actorRef, agentRef, selectedResourceRef, graph, agentGraph, agentGraphLoading, agentGraphError } = input;
  const actorLabel = actor ? graphUserLabel(actor) : "Actor";
  const agentLabel = agentRef ? nodeLabel(graph, agentRef) : "Agent";
  const steps: FeatureCheckStep[] = [];
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  const addNode = (ref: string, label: string, type = objectType(ref)) => {
    if (!nodes.has(ref)) nodes.set(ref, { id: ref, label, type });
  };
  const addFeatureEdge = (step: FeatureCheckStep) => {
    addNode(step.subject, step.subject === actorRef ? actorLabel : nodeLabel(agentGraph ?? graph, step.subject));
    addNode(step.object, nodeLabel(agentGraph ?? graph, step.object));
    edges.push({
      id: `feature:${step.id}`,
      from: step.subject,
      to: step.object,
      relation: step.relation,
      status: step.status,
      kind: "effective",
      layer: "effective",
    });
  };
  const pushStep = (step: FeatureCheckStep) => {
    steps.push(step);
    if (step.status !== "skipped") addFeatureEdge(step);
  };

  if (!actorRef || !agentRef) {
    pushStep({
      id: "select-actor-agent",
      label: "Select actor and agent",
      status: "unknown",
      subject: actorRef ?? "actor:unknown",
      relation: "needs_target",
      object: agentRef ?? "agent:unknown",
      detail: "Choose who is performing the action and which agent they are trying to use.",
    });
  } else {
    const invokeEdge = findEffectiveEdge({
      graph,
      source: actorRef,
      target: agentRef,
      relations: ["can_use"],
    });
    pushStep({
      id: "actor-can-use-agent",
      label: "Actor can invoke agent",
      status: invokeEdge ? "allowed" : "blocked",
      subject: actorRef,
      relation: "can_use",
      object: agentRef,
      detail: invokeEdge
        ? `${actorLabel} can start ${agentLabel} via ${viaLabel(graph, agentRef, ["user", "owner", "manager"])}.`
        : `${actorLabel} does not have can_use on ${agentLabel}.`,
      missingGrant: invokeEdge ? undefined : `${actorRef} can_use ${agentRef}`,
    });
  }

  if (feature === "invoke_agent") {
    const decision = statusDecision(steps);
    return {
      decision,
      headline: decision === "allow" ? `${actorLabel} can invoke ${agentLabel}.` : `${actorLabel} cannot invoke ${agentLabel}.`,
      subline: "This checks the first runtime gate before the chat request reaches the agent.",
      steps,
      missingGrants: steps.flatMap((step) => (step.missingGrant ? [step.missingGrant] : [])),
      featureGraph: { nodes: [...nodes.values()], edges },
    };
  }

  if (!agentRef) {
    const decision = statusDecision(steps);
    return {
      decision,
      headline: "Select an agent to evaluate downstream access.",
      subline: "Feature checks need the agent because downstream MCP, KB, and skill calls are evaluated as the agent principal.",
      steps,
      missingGrants: steps.flatMap((step) => (step.missingGrant ? [step.missingGrant] : [])),
      featureGraph: { nodes: [...nodes.values()], edges },
    };
  }

  if (agentGraphLoading) {
    pushStep({
      id: "agent-runtime-access-loading",
      label: "Load agent runtime access",
      status: "unknown",
      subject: agentRef,
      relation: "loads",
      object: "runtime:downstream-access",
      detail: "Loading the agent's effective access to downstream resources.",
    });
  } else if (agentGraphError) {
    pushStep({
      id: "agent-runtime-access-error",
      label: "Load agent runtime access",
      status: "unknown",
      subject: agentRef,
      relation: "loads",
      object: "runtime:downstream-access",
      detail: agentGraphError,
    });
  } else if (feature === "agent_call_tool") {
    const toolEdge = findEffectiveEdge({
      graph: agentGraph,
      source: agentRef,
      target: selectedResourceRef || undefined,
      targetTypes: FEATURE_RESOURCE_TYPES.agent_call_tool,
      relations: FEATURE_RESOURCE_RELATIONS.agent_call_tool,
    });
    const targetLabel = selectedResourceRef ? nodeLabel(agentGraph ?? graph, selectedResourceRef) : "at least one MCP/tool";
    pushStep({
      id: "agent-can-call-tool",
      label: "Agent can call MCP/tool",
      status: toolEdge ? "allowed" : "blocked",
      subject: agentRef,
      relation: "can_call",
      object: toolEdge?.to ?? (selectedResourceRef || "tool:<server>/*"),
      detail: toolEdge
        ? `${agentLabel} can call ${nodeLabel(agentGraph ?? graph, toolEdge.to)}.`
        : `${agentLabel} has no visible can_call grant for ${targetLabel}.`,
      missingGrant: toolEdge ? undefined : suggestedToolGrant(agentRef, selectedResourceRef),
    });
  } else if (feature === "agent_use_rag") {
    const searchEdge = findEffectiveEdge({
      graph,
      source: actorRef,
      target: "organization:caipe",
      relations: ["can_search"],
    });
    pushStep({
      id: "actor-can-search-org",
      label: "Actor has RAG search capability",
      status: searchEdge ? "allowed" : "blocked",
      subject: actorRef ?? "actor:unknown",
      relation: "can_search",
      object: "organization:caipe",
      detail: searchEdge
        ? `${actorLabel} has organization search enabled.`
        : `${actorLabel} is missing organization-level can_search.`,
      missingGrant: searchEdge ? undefined : `${actorRef ?? "user:<id>"} can_search organization:caipe`,
    });
    const ragEdge = findEffectiveEdge({
      graph: selectedResourceRef ? graph : agentGraph ?? graph,
      source: selectedResourceRef ? actorRef : agentRef,
      target: selectedResourceRef || undefined,
      targetTypes: ["knowledge_base", "data_source"],
      relations: ["can_read", "can_search", "can_use", "can_ingest"],
    });
    pushStep({
      id: "kb-resource-access",
      label: "KB or data source access",
      status: ragEdge ? "allowed" : selectedResourceRef ? "blocked" : "unknown",
      subject: ragEdge?.from ?? actorRef ?? agentRef,
      relation: ragEdge?.relation ?? "can_read",
      object: ragEdge?.to ?? (selectedResourceRef || "knowledge_base:<id>"),
      detail: ragEdge
        ? `${nodeLabel(graph, ragEdge.from)} can reach ${nodeLabel(agentGraph ?? graph, ragEdge.to)}.`
        : selectedResourceRef
          ? `No can_read/can_search path is visible for ${nodeLabel(agentGraph ?? graph, selectedResourceRef)}.`
          : "Pick a KB or data source to verify the content-level gate.",
      missingGrant: ragEdge || !selectedResourceRef ? undefined : `${actorRef ?? agentRef} can_read ${selectedResourceRef}`,
    });
  } else if (feature === "agent_use_skill") {
    const skillEdge = findEffectiveEdge({
      graph: agentGraph,
      source: agentRef,
      target: selectedResourceRef || undefined,
      targetTypes: FEATURE_RESOURCE_TYPES.agent_use_skill,
      relations: FEATURE_RESOURCE_RELATIONS.agent_use_skill,
    });
    pushStep({
      id: "skill-runtime-gate",
      label: "Skill runtime authorization",
      status: skillEdge ? "allowed" : "not_enforced",
      subject: agentRef,
      relation: skillEdge?.relation ?? "role_gated",
      object: skillEdge?.to ?? (selectedResourceRef || "skill:<id>"),
      detail: skillEdge
        ? `${agentLabel} has a visible skill relationship.`
        : "Skill invocation is currently role-gated/catalog-gated rather than a direct OpenFGA runtime check.",
    });
  }

  const decision = statusDecision(steps);
  const blocked = steps.find((step) => step.status === "blocked");
  const unknown = steps.find((step) => step.status === "unknown");
  const headline = blocked
    ? `${actorLabel} is blocked at: ${blocked.label}.`
    : unknown
      ? `${actorLabel}'s feature path needs one more target.`
      : decision === "partial"
        ? `${actorLabel}'s path is partially explainable.`
        : `${actorLabel} can perform this feature path.`;

  return {
    decision,
    headline,
    subline: blocked
      ? blocked.detail
      : "The checklist follows the runtime principal switch from actor to agent to downstream resources.",
    steps,
    missingGrants: steps.flatMap((step) => (step.missingGrant ? [step.missingGrant] : [])),
    featureGraph: { nodes: [...nodes.values()], edges },
  };
}

// ── End effective-access card helpers ──────────────────────────────────────

function modelTypeFromNodeId(nodeId: string): string | null {
  const match = /^model:(?:resource_type|relation|permission|relation_stack|permission_stack):([^:]+)/.exec(nodeId);
  return match?.[1] ?? null;
}

function modelStackItems(
  graph: { nodes: GraphNode[] },
  modelType: string,
  nodeType: "model_relation" | "model_permission"
): string[] {
  return [
    ...new Set(
      graph.nodes
        .filter((node) => node.type === nodeType && modelTypeFromNodeId(node.id) === modelType)
        .map((node) => node.label)
        .filter(Boolean)
    ),
  ].sort((left, right) => left.localeCompare(right));
}

export function AccessExplorerTab({ isAdmin }: { isAdmin: boolean }) {
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>({ nodes: [], edges: [] });
  const [error, setError] = useState<string | null>(null);
  const [graphUser, setGraphUser] = useState<RebacGraphUserOption | null>(null);
  const [graphFullscreenOpen, setGraphFullscreenOpen] = useState(false);
  const [graphRendered, setGraphRendered] = useState(false);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [graphRendering, setGraphRendering] = useState(false);
  const [graphPrincipal, setGraphPrincipal] = useState<RebacGraphUserOption | null>(null);
  const [explorerMode, setExplorerMode] = useState<ExplorerMode>("feature-check");
  const [featureKind, setFeatureKind] = useState<FeatureKind>("agent_call_tool");
  const [featureAgentRef, setFeatureAgentRef] = useState("");
  const [featureResourceRef, setFeatureResourceRef] = useState("");
  const [featureAgentGraph, setFeatureAgentGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [featureAgentGraphLoading, setFeatureAgentGraphLoading] = useState(false);
  const [featureAgentGraphError, setFeatureAgentGraphError] = useState<string | null>(null);

  const toggleType = useCallback((type: string) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  // Derive (type → unique resource count) from effective edges; reset when graph changes.
  const availableTypes = useMemo((): [string, number][] => {
    const resourceIds = new Map<string, Set<string>>();
    for (const edge of graph.edges) {
      if (edge.kind !== "effective") continue;
      const type = edge.to.split(":")[0];
      if (!type || SYSTEM_NODE_TYPES.has(type)) continue;
      if (!resourceIds.has(type)) resourceIds.set(type, new Set());
      resourceIds.get(type)!.add(edge.to);
    }
    return [...resourceIds.entries()]
      .map(([type, ids]) => [type, ids.size] as [string, number])
      .sort(([a], [b]) => {
        const ai = RESOURCE_TYPE_ORDER.indexOf(a);
        const bi = RESOURCE_TYPE_ORDER.indexOf(b);
        if (ai === -1 && bi === -1) return a.localeCompare(b);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
  }, [graph]);

  const handleGraphUserChange = useCallback((u: RebacGraphUserOption | null) => {
    setGraphUser(u);
    setGraphRendered(false);
    if (u?.kind !== "agent") setGraphPrincipal(null);
    setFeatureAgentRef("");
    setFeatureResourceRef("");
    setFeatureAgentGraph(null);
    setFeatureAgentGraphError(null);
    if (!u) {
      setGraph({ nodes: [], edges: [] });
      setHiddenTypes(new Set());
      setGraphPrincipal(null);
    }
  }, []);

  const handleGraphPrincipalChange = useCallback((principal: RebacGraphUserOption | null) => {
    setGraphPrincipal(principal);
    setGraphRendered(false);
    setFeatureResourceRef("");
  }, []);

  const loadGraph = useCallback(async () => {
    if (!graphUser) return;
    setGraphRendering(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (graphUser.kind === "agent") {
        params.set("resource_type", "agent");
        params.set("resource_id", graphUser.id);
        if (graphPrincipal) params.set("subject", graphEntitySubjectRef(graphPrincipal));
      } else if (isResourceEntity(graphUser)) {
        const resource = graphEntityResourceScope(graphUser);
        params.set("resource_type", resource.type);
        params.set("resource_id", resource.id);
      } else {
        params.set("subject", graphEntitySubjectRef(graphUser));
      }
      params.set("layer", "effective");
      params.set("limit", "1000");
      const res = await fetch(`/api/admin/rebac/graph?${params.toString()}`);
      if (!res.ok) throw new Error(`Failed to load graph: ${res.status}`);
      const payload = await res.json();
      setGraph(apiData<{ nodes: GraphNode[]; edges: GraphEdge[] }>(payload));
      setGraphRendered(true);
      setExplorerMode(isResourceEntity(graphUser) && graphUser.kind !== "agent" ? "relationships" : "feature-check");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to render access graph.");
    } finally {
      setGraphRendering(false);
    }
  }, [graphPrincipal, graphUser]);

  const featureActor = graphUser?.kind === "agent" ? graphPrincipal : isActorEntity(graphUser) ? graphUser : null;
  const featureActorRef = featureActor ? graphEntitySubjectRef(featureActor) : null;

  const targetAgentOptions = useMemo(() => {
    if (graphUser?.kind === "agent") {
      const ref = `agent:${graphUser.id}`;
      return [{ id: ref, label: graphUserLabel(graphUser), type: "agent" }];
    }
    return effectiveResourceOptions({
      graph,
      source: featureActorRef,
      types: ["agent"],
      relations: ["can_use"],
    });
  }, [featureActorRef, graph, graphUser]);

  const selectedFeatureAgentRef = graphUser?.kind === "agent"
    ? `agent:${graphUser.id}`
    : featureAgentRef || targetAgentOptions[0]?.id || "";

  useEffect(() => {
    if (graphUser?.kind === "agent") {
      setFeatureAgentRef(`agent:${graphUser.id}`);
      return;
    }
    if (!graphRendered) return;
    if (targetAgentOptions.length === 0) {
      setFeatureAgentRef("");
      setFeatureResourceRef("");
      return;
    }
    if (!featureAgentRef || !targetAgentOptions.some((option) => option.id === featureAgentRef)) {
      setFeatureAgentRef(targetAgentOptions[0]?.id ?? "");
      setFeatureResourceRef("");
    }
  }, [featureAgentRef, graphRendered, graphUser, targetAgentOptions]);

  useEffect(() => {
    if (!graphRendered || !selectedFeatureAgentRef) {
      setFeatureAgentGraph(null);
      setFeatureAgentGraphError(null);
      setFeatureAgentGraphLoading(false);
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({
      subject: selectedFeatureAgentRef,
      layer: "effective",
      limit: "1000",
    });
    setFeatureAgentGraphLoading(true);
    setFeatureAgentGraphError(null);
    fetch(`/api/admin/rebac/graph?${params.toString()}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load agent runtime graph: ${res.status}`);
        const payload = await res.json();
        setFeatureAgentGraph(apiData<{ nodes: GraphNode[]; edges: GraphEdge[] }>(payload));
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setFeatureAgentGraph(null);
        setFeatureAgentGraphError(err instanceof Error ? err.message : "Failed to load agent runtime access.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setFeatureAgentGraphLoading(false);
      });
    return () => controller.abort();
  }, [graphRendered, selectedFeatureAgentRef]);

  const featureResourceOptions = useMemo(() => {
    if (featureKind === "invoke_agent") return [];
    const types = FEATURE_RESOURCE_TYPES[featureKind];
    const relations = FEATURE_RESOURCE_RELATIONS[featureKind];
    if (featureKind === "agent_use_rag") {
      const actorOptions = effectiveResourceOptions({ graph, source: featureActorRef, types, relations });
      const agentOptions = effectiveResourceOptions({
        graph: featureAgentGraph,
        source: selectedFeatureAgentRef,
        types,
        relations,
      });
      return [...new Map([...actorOptions, ...agentOptions].map((option) => [option.id, option])).values()];
    }
    return effectiveResourceOptions({
      graph: featureAgentGraph,
      source: selectedFeatureAgentRef,
      types,
      relations,
    });
  }, [featureActorRef, featureAgentGraph, featureKind, graph, selectedFeatureAgentRef]);

  useEffect(() => {
    if (!featureResourceRef) return;
    if (!featureResourceOptions.some((option) => option.id === featureResourceRef)) {
      setFeatureResourceRef("");
    }
  }, [featureResourceOptions, featureResourceRef]);

	  const featureCheckResult = useMemo(() => buildFeatureCheckResult({
    feature: featureKind,
    actor: featureActor,
    actorRef: featureActorRef,
    agentRef: selectedFeatureAgentRef || null,
    selectedResourceRef: featureResourceRef,
    graph,
    agentGraph: featureAgentGraph,
    agentGraphLoading: featureAgentGraphLoading,
    agentGraphError: featureAgentGraphError,
  }), [
    featureActor,
    featureActorRef,
    featureAgentGraph,
    featureAgentGraphError,
    featureAgentGraphLoading,
    featureKind,
    featureResourceRef,
    graph,
    selectedFeatureAgentRef,
  ]);

	  if (!isAdmin) {
	    return <p className="text-sm text-muted-foreground">Admin access required.</p>;
	  }
	  const resourceRelationshipsOnly = isResourceEntity(graphUser) && graphUser.kind !== "agent";
	  const effectiveCardsSubject = graphUser?.kind === "agent"
	    ? graphPrincipal
	    : isActorEntity(graphUser)
	      ? graphUser
	      : null;

	  return (
    <div className="space-y-3">
      {graphRendered ? (
        <div data-testid="access-explorer-header" className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <RebacGraphFilters
              selectedUser={graphUser}
              onUserChange={handleGraphUserChange}
              onRender={loadGraph}
              rendering={graphRendering}
            />
            {graphUser?.kind === "agent" && (
              <ExploreAsPrincipalPicker
                selectedPrincipal={graphPrincipal}
                onPrincipalChange={handleGraphPrincipalChange}
              />
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            title="Full screen"
            onClick={() => setGraphFullscreenOpen(true)}
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            title="Full screen"
            onClick={() => setGraphFullscreenOpen(true)}
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4" />
          {error}
        </div>
      )}

      {!graphRendered && !graphRendering && (
        <div data-testid="access-explorer-search-stage" className="flex min-h-[420px] items-center justify-center">
          <div className="w-full max-w-4xl space-y-3">
            <RebacGraphFilters
              selectedUser={graphUser}
              onUserChange={handleGraphUserChange}
              onRender={loadGraph}
              rendering={graphRendering}
            />
            {graphUser?.kind === "agent" && (
              <ExploreAsPrincipalPicker
                selectedPrincipal={graphPrincipal}
                onPrincipalChange={handleGraphPrincipalChange}
              />
            )}
          </div>
        </div>
      )}

      {graphRendering && !graphRendered && (
        <div className="flex min-h-[320px] items-center justify-center rounded-md border bg-muted/10">
          <CAIPESpinner size="lg" message="Checking access..." />
        </div>
      )}

      {graphRendered && (
        <Tabs
          value={resourceRelationshipsOnly ? "relationships" : explorerMode}
          onValueChange={(value) => setExplorerMode(value as ExplorerMode)}
          className="space-y-3"
        >
          <TabsList aria-label="Access Explorer mode" className="h-9">
            {!resourceRelationshipsOnly && (
              <TabsTrigger value="feature-check" className="gap-2 text-xs">
                <ListChecks className="h-3.5 w-3.5" />
                Feature Check
              </TabsTrigger>
            )}
            <TabsTrigger value="relationships" className="gap-2 text-xs">
              <GitBranch className="h-3.5 w-3.5" />
              Relationships
            </TabsTrigger>
          </TabsList>
	          {!resourceRelationshipsOnly && (
	            <TabsContent value="feature-check" className="mt-0">
	              <FeatureCheckPanel
	                result={featureCheckResult}
	                featureKind={featureKind}
	                onFeatureKindChange={(next) => {
	                  setFeatureKind(next);
	                  setFeatureResourceRef("");
	                }}
	                actor={featureActor}
	                agentOptions={targetAgentOptions}
	                selectedAgentRef={selectedFeatureAgentRef}
	                onAgentChange={(next) => {
	                  setFeatureAgentRef(next);
	                  setFeatureResourceRef("");
	                }}
	                resourceOptions={featureResourceOptions}
	                selectedResourceRef={featureResourceRef}
	                onResourceChange={setFeatureResourceRef}
	                agentLocked={graphUser?.kind === "agent"}
	                loadingAgentGraph={featureAgentGraphLoading}
	              />
	            </TabsContent>
	          )}
          <TabsContent value="relationships" className="mt-0 space-y-3">
            {availableTypes.length > 0 && (
              <ResourceTypeFilter
                availableTypes={availableTypes}
                hiddenTypes={hiddenTypes}
                onToggle={toggleType}
              />
            )}
            <GraphSummary graph={graph} />
            <OpenFgaGraphViewer
              graph={graph}
              graphLayer="effective"
              showUsers={Boolean(graphUser)}
              hiddenTypes={hiddenTypes}
              availableTypes={availableTypes}
              onToggleType={toggleType}
            />
            <GraphDetails graph={graph} />
	            {effectiveCardsSubject && graph.nodes.length > 0 && (
	              <EffectiveAccessCards
	                graph={graph}
	                subject={effectiveCardsSubject}
	                emptyMessage={graphUser?.kind === "agent" && graphPrincipal
	                  ? "No OpenFGA relationship found for the selected actor and agent."
	                  : undefined}
	              />
	            )}
          </TabsContent>
        </Tabs>
      )}
          <Dialog open={graphFullscreenOpen} onOpenChange={setGraphFullscreenOpen}>
            <DialogContent className="flex h-[92vh] max-h-[92vh] min-w-0 w-[96vw] max-w-[96vw] flex-col gap-3 overflow-hidden p-4">
              <DialogHeader className="min-w-0 shrink-0 pr-10">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <DialogTitle>Access Explorer</DialogTitle>
                    <DialogDescription>Access Relationships</DialogDescription>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    onClick={() => setGraphFullscreenOpen(false)}
                  >
                    <Minimize2 className="h-4 w-4" />
                    Exit full screen
                  </Button>
                </div>
              </DialogHeader>
              <div className="min-w-0 shrink-0 rounded-md border bg-muted/10 p-3">
                <RebacGraphFilters
                  selectedUser={graphUser}
                  idPrefix="graph-fullscreen"
                  onUserChange={handleGraphUserChange}
                  onRender={loadGraph}
                  rendering={graphRendering}
                />
                {graphUser?.kind === "agent" && (
                  <div className="mt-2">
                    <ExploreAsPrincipalPicker
                      selectedPrincipal={graphPrincipal}
                      onPrincipalChange={handleGraphPrincipalChange}
                      idPrefix="graph-fullscreen-principal"
                    />
                  </div>
                )}
                {graphUser && !graphRendered && !graphRendering && (
                  <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    Click <strong>Check Access</strong> to visualize access.
                  </p>
                )}
              </div>
              {graphRendering && !graphRendered ? (
                <div className="flex min-h-0 flex-1 items-center justify-center rounded-md border bg-muted/10">
                  <CAIPESpinner size="lg" message="Checking access..." />
                </div>
              ) : graphRendered ? (
                <Tabs
                  value={resourceRelationshipsOnly ? "relationships" : explorerMode}
                  onValueChange={(value) => setExplorerMode(value as ExplorerMode)}
                  className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
                >
                  <TabsList aria-label="Access Explorer fullscreen mode" className="h-9 shrink-0">
                    {!resourceRelationshipsOnly && (
                      <TabsTrigger value="feature-check" className="gap-2 text-xs">
                        <ListChecks className="h-3.5 w-3.5" />
                        Feature Check
                      </TabsTrigger>
                    )}
                    <TabsTrigger value="relationships" className="gap-2 text-xs">
                      <GitBranch className="h-3.5 w-3.5" />
                      Relationships
                    </TabsTrigger>
                  </TabsList>
                  {!resourceRelationshipsOnly && (
                    <TabsContent value="feature-check" className="min-h-0 flex-1 overflow-auto pr-1">
                      <FeatureCheckPanel
                        result={featureCheckResult}
                        featureKind={featureKind}
                        onFeatureKindChange={(next) => {
                          setFeatureKind(next);
                          setFeatureResourceRef("");
                        }}
                        actor={featureActor}
                        agentOptions={targetAgentOptions}
                        selectedAgentRef={selectedFeatureAgentRef}
                        onAgentChange={(next) => {
                          setFeatureAgentRef(next);
                          setFeatureResourceRef("");
                        }}
                        resourceOptions={featureResourceOptions}
                        selectedResourceRef={featureResourceRef}
                        onResourceChange={setFeatureResourceRef}
                        agentLocked={graphUser?.kind === "agent"}
                        loadingAgentGraph={featureAgentGraphLoading}
                      />
                    </TabsContent>
                  )}
                  <TabsContent value="relationships" className="min-h-0 flex-1 overflow-hidden">
                    <OpenFgaGraphViewer
                      graph={graph}
                      graphLayer="effective"
                      showUsers={Boolean(graphUser)}
                      hiddenTypes={hiddenTypes}
                      availableTypes={availableTypes}
                      onToggleType={toggleType}
                      fullscreen
                    />
                  </TabsContent>
                </Tabs>
              ) : (
                <div className="flex min-h-0 flex-1 items-center justify-center rounded-md border bg-muted/10 text-sm text-muted-foreground">
                  {graphUser
                    ? "Click Check Access above to load the visualization."
                    : "Search for an entity, then click Check Access."}
                </div>
              )}
            </DialogContent>
          </Dialog>
    </div>
  );
}

function FeatureCheckPanel({
  result,
  featureKind,
  onFeatureKindChange,
  actor,
  agentOptions,
  selectedAgentRef,
  onAgentChange,
  resourceOptions,
  selectedResourceRef,
  onResourceChange,
  agentLocked,
  loadingAgentGraph,
}: {
  result: FeatureCheckResult;
  featureKind: FeatureKind;
  onFeatureKindChange: (feature: FeatureKind) => void;
  actor: RebacGraphUserOption | null;
  agentOptions: FeatureResourceOption[];
  selectedAgentRef: string;
  onAgentChange: (agentRef: string) => void;
  resourceOptions: FeatureResourceOption[];
  selectedResourceRef: string;
  onResourceChange: (resourceRef: string) => void;
  agentLocked: boolean;
  loadingAgentGraph: boolean;
}) {
  const activeFeature = FEATURE_OPTIONS.find((option) => option.value === featureKind) ?? FEATURE_OPTIONS[0]!;
  const decisionMeta = result.decision === "allow"
    ? FEATURE_STATUS_META.allowed
    : result.decision === "deny"
      ? FEATURE_STATUS_META.blocked
      : result.decision === "partial"
        ? FEATURE_STATUS_META.not_enforced
        : FEATURE_STATUS_META.unknown;
  const DecisionIcon = decisionMeta.icon;
  const showResourcePicker = featureKind !== "invoke_agent";

  return (
    <div className="space-y-3" data-testid="feature-check-panel">
      <div className="grid gap-3 rounded-md border bg-muted/10 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <FeatureSelectField label="Actor">
          <div className="flex h-10 min-w-0 items-center gap-2 rounded-md border bg-background px-3 text-sm">
            <User className="h-4 w-4 text-sky-400" />
            <span className="truncate">{actor ? graphUserLabel(actor) : "Select an actor"}</span>
          </div>
        </FeatureSelectField>
        <FeatureSelectField label="Feature">
          <Select
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            value={featureKind}
            onChange={(event) => onFeatureKindChange(event.target.value as FeatureKind)}
          >
            {FEATURE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </FeatureSelectField>
        <FeatureSelectField label="Agent">
          <AgentPicker
            ariaLabel="Feature check agent"
            value={selectedAgentRef}
            onChange={onAgentChange}
            options={agentOptions.map((option) => ({
              value: option.id,
              label: option.label,
            }))}
            disabled={agentLocked || agentOptions.length === 0}
            placeholder={agentOptions.length === 0 ? "No reachable agents" : "Select an agent"}
            searchPlaceholder="Search reachable agents..."
            emptyLabel="No reachable agents match"
            triggerClassName="h-10"
            hideIdSuffix
            allowClear={false}
          />
        </FeatureSelectField>
        {showResourcePicker && (
          <FeatureSelectField label={activeFeature.targetLabel} className="lg:col-span-3">
            <SearchablePicker
              options={resourceOptions}
              selected={resourceOptions.find(
                (option) => option.id === selectedResourceRef,
              )}
              onSelect={(option) => onResourceChange(option.id)}
              getOptionKey={(option) => option.id}
              getOptionLabel={(option) => `${option.label} (${option.id})`}
              getSearchText={(option) => [option.id, option.label]}
              placeholder={`Any ${activeFeature.targetLabel.toLowerCase()}`}
              searchPlaceholder={`Search ${activeFeature.targetLabel.toLowerCase()}...`}
              emptyLabel={`No ${activeFeature.targetLabel.toLowerCase()} match`}
              ariaLabel={activeFeature.targetLabel}
              disabled={loadingAgentGraph}
              onClear={() => onResourceChange("")}
              clearLabel={`Clear ${activeFeature.targetLabel.toLowerCase()}`}
              triggerClassName="h-10 text-sm"
            />
          </FeatureSelectField>
        )}
      </div>

      <div className={cn("rounded-md border p-4", decisionMeta.className)}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <DecisionIcon className="h-5 w-5 shrink-0" />
              <h3 className="text-base font-semibold text-foreground">{result.headline}</h3>
            </div>
            <p className="text-sm text-muted-foreground">{result.subline}</p>
          </div>
          <Badge variant="outline" className={cn("shrink-0", decisionMeta.className)}>
            {decisionMeta.label}
          </Badge>
        </div>
      </div>

      {result.featureGraph.nodes.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            Feature Path
          </div>
          <OpenFgaGraphViewer
            graph={result.featureGraph}
            graphLayer="effective"
            showUsers
            compact
          />
        </div>
      )}

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="rounded-md border bg-muted/10 p-3">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <ListChecks className="h-4 w-4 text-muted-foreground" />
            Access Checklist
          </div>
          <div className="space-y-2">
            {result.steps.map((step, index) => (
              <FeatureCheckStepRow key={step.id} step={step} index={index + 1} />
            ))}
          </div>
        </div>

        <div className="rounded-md border bg-muted/10 p-3">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Wrench className="h-4 w-4 text-muted-foreground" />
            Fix Panel
          </div>
          {result.missingGrants.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Add or reconcile these missing checks, then render again.</p>
              {result.missingGrants.map((grant) => (
                <code key={grant} className="block rounded-md border bg-background px-2 py-1.5 text-[11px] text-foreground">
                  {grant}
                </code>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No missing OpenFGA grant is visible for the selected feature path.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function FeatureSelectField({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn("min-w-0 space-y-1", className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function FeatureCheckStepRow({ step, index }: { step: FeatureCheckStep; index: number }) {
  const meta = FEATURE_STATUS_META[step.status];
  const Icon = meta.icon;
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px]">
              {index}
            </span>
            {step.label}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{step.detail}</p>
        </div>
        <Badge variant="outline" className={cn("gap-1", meta.className)}>
          <Icon className="h-3 w-3" />
          {meta.label}
        </Badge>
      </div>
      <div className="mt-2 min-w-0 rounded-md bg-muted/40 px-2 py-1 text-[11px]">
        <code className="break-all">{step.subject}</code>{" "}
        <span className="text-muted-foreground">{step.relation}</span>{" "}
        <code className="break-all">{step.object}</code>
      </div>
    </div>
  );
}

function GraphSummary({ graph }: { graph: { nodes: GraphNode[]; edges: GraphEdge[] } }) {
  const grouped = graph.edges.reduce<Record<string, GraphEdge[]>>((acc, edge) => {
    acc[edge.relation] = [...(acc[edge.relation] ?? []), edge];
    return acc;
  }, {});

  return (
    <div className="grid gap-3 md:grid-cols-3">
      <MetricCard label="Nodes" value={graph.nodes.length} testId="access-explorer-nodes-count" />
      <MetricCard label="Relationships" value={graph.edges.length} testId="access-explorer-relationships-count" />
      <MetricCard label="Relation types" value={Object.keys(grouped).length} testId="access-explorer-relation-types-count" />
    </div>
  );
}

function ExploreAsPrincipalPicker({
  selectedPrincipal,
  onPrincipalChange,
  idPrefix = "graph-principal",
}: {
  selectedPrincipal: RebacGraphUserOption | null;
  onPrincipalChange: (principal: RebacGraphUserOption | null) => void;
  idPrefix?: string;
}) {
  return (
    <div data-testid="access-explorer-principal-picker" className="grid gap-2 sm:grid-cols-[6.5rem_minmax(0,1fr)]">
      <div className="flex items-center text-xs font-medium text-muted-foreground">Explore as</div>
      <RebacGraphFilters
        selectedUser={selectedPrincipal}
        idPrefix={idPrefix}
        onUserChange={onPrincipalChange}
        onRender={() => undefined}
        includeAgents={false}
        includeUnlinkedServiceAccount
        includeResources={false}
        placeholder="Search team, user, service account, or unlinked service account..."
        showRenderButton={false}
      />
    </div>
  );
}

function GraphDetails({ graph }: { graph: { nodes: GraphNode[]; edges: GraphEdge[] } }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-md border bg-muted/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">Node and edge details</div>
          <p className="text-xs text-muted-foreground">
            Raw graph inventory is collapsed by default to keep the policy canvas readable.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setExpanded((current) => !current)}>
          {expanded ? "Hide node and edge details" : "Show node and edge details"}
        </Button>
      </div>
      {expanded && (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="rounded-md border p-3">
            <div className="mb-2 text-sm font-medium">Nodes</div>
            <div className="flex flex-wrap gap-2">
              {graph.nodes.length === 0 ? (
                <span className="text-sm text-muted-foreground">No graph nodes loaded.</span>
              ) : (
                graph.nodes.map((node) => {
                  const meta = graphKindMeta(node.type);
                  const Icon = meta.icon;
                  return (
                    <Badge key={node.id} variant="secondary" className="gap-1.5">
                      <Icon className="h-3 w-3" aria-hidden="true" />
                      <span className="text-muted-foreground">{meta.label}</span>
                      {node.label}
                    </Badge>
                  );
                })
              )}
            </div>
          </div>
          <div className="rounded-md border p-3">
            <div className="mb-2 text-sm font-medium">Edges</div>
            <div className="space-y-2">
              {graph.edges.length === 0 ? (
                <span className="text-sm text-muted-foreground">No graph edges loaded.</span>
              ) : (
                graph.edges.map((edge) => (
                  <div key={edge.id} className="rounded bg-muted/40 p-2 text-xs">
                    {edge.kind === "metadata" && (
                      <Badge variant="outline" className="mb-1">
                        routing metadata
                      </Badge>
                    )}
                    <code>{edge.from}</code> <span className="text-muted-foreground">{edge.relation}</span>{" "}
                    <code>{edge.to}</code>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface OpenFgaGraphViewerProps {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  graphLayer: GraphLayer;
  showUsers?: boolean;
  fullscreen?: boolean;
  compact?: boolean;
  hiddenTypes?: Set<string>;
  availableTypes?: [string, number][];
  onToggleType?: (type: string) => void;
}

function OpenFgaGraphViewer(props: OpenFgaGraphViewerProps) {
  return (
    <ReactFlowProvider>
      <OpenFgaGraphViewerInner {...props} />
    </ReactFlowProvider>
  );
}

function OpenFgaGraphViewerInner({
  graph,
  graphLayer,
  showUsers = false,
  fullscreen = false,
  compact = false,
  hiddenTypes = EMPTY_HIDDEN_TYPES,
  availableTypes = EMPTY_AVAILABLE_TYPES,
  onToggleType,
}: OpenFgaGraphViewerProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<RebacNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<RebacEdgeData>>([]);

  useEffect(() => {
    const nextNodes = buildFlowNodes(graph, showUsers, graphLayer, hiddenTypes);
    const visibleNodeIds = new Set(nextNodes.map((node) => node.id));
    setNodes(nextNodes);
    setEdges(buildFlowEdges(graph, visibleNodeIds, graphLayer, hiddenTypes));
  }, [graph, graphLayer, hiddenTypes, setEdges, setNodes, showUsers]);

  return (
    <div
      data-testid="openfga-graph-canvas"
      className={cn(
        "min-w-0 overflow-hidden rounded-md border bg-background",
        fullscreen ? "h-full min-h-0" : compact ? "h-[320px]" : "h-[560px]"
      )}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={GRAPH_NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodesConnectable={false}
        fitView
        fitViewOptions={{ padding: 0.3 }}
      >
        <OpenFgaGraphControls />
        {fullscreen && availableTypes.length > 0 && onToggleType && (
          <Panel position="top-right">
            <div className="rounded-lg border bg-card/95 p-3 shadow-lg backdrop-blur-sm max-w-xs">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Filter by type
              </p>
              <div className="flex flex-wrap gap-1.5">
                {availableTypes.map(([type, count]) => {
                  const meta = graphKindMeta(type);
                  const Icon = meta.icon;
                  const active = !hiddenTypes.has(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => onToggleType(type)}
                      title={active ? `Hide ${meta.label}s` : `Show ${meta.label}s`}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-all",
                        active
                          ? "border-transparent bg-muted text-foreground hover:bg-muted/70"
                          : "border-border bg-background text-muted-foreground opacity-40 hover:opacity-70"
                      )}
                    >
                      <Icon className="h-2.5 w-2.5" />
                      {meta.label}
                      <span className="rounded-full bg-background/60 px-1 py-px text-[9px] tabular-nums">
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </Panel>
        )}
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="hsl(var(--muted-foreground) / 0.15)"
        />
      </ReactFlow>
    </div>
  );
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;
const EMPTY_HIDDEN_TYPES = new Set<string>();
const EMPTY_AVAILABLE_TYPES: [string, number][] = [];

function buildFlowNodes(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  showUsers: boolean,
  graphLayer: GraphLayer,
  hiddenTypes: Set<string> = new Set()
): Node<RebacNodeData>[] {
  const nodesById = new Map<string, FlowNodeDefinition>();
  const addNode = (id: string, label = id, kind = nodeKind(id), extra: Partial<FlowNodeDefinition> = {}) => {
    if (!nodesById.has(id)) {
      nodesById.set(id, { id, label, kind: kind === "team_members" ? "userset" : kind, object: id, ...extra });
    }
  };

  if (graphLayer === "model") {
    graph.nodes
      .filter((node) => node.type === "model_resource_type")
      .forEach((node) => addNode(node.id, node.label, node.type));
    new Set(
      graph.nodes
        .filter((node) => node.type === "model_resource_type")
        .map((node) => modelTypeFromNodeId(node.id))
        .filter((type): type is string => Boolean(type))
    ).forEach((modelType) => {
      const relationItems = modelStackItems(graph, modelType, "model_relation");
      const permissionItems = modelStackItems(graph, modelType, "model_permission");
      if (relationItems.length > 0) {
        addNode(`model:relation_stack:${modelType}`, "Relations", "model_relation_stack", { items: relationItems });
      }
      if (permissionItems.length > 0) {
        addNode(`model:permission_stack:${modelType}`, "Permissions", "model_permission_stack", {
          items: permissionItems,
        });
      }
    });
  } else {
    graph.nodes.forEach((node) => addNode(node.id, node.label, node.type));
    graph.edges.forEach((edge) => {
      addNode(edge.from);
      addNode(edge.to);
    });
  }

  // For the effective layer: pre-compute which nodes participate in effective
  // edges so non-user principals stay visible while inherited usersets remain hidden.
  const effectiveResourceIds = graphLayer === "effective"
    ? new Set(graph.edges.filter((e) => e.kind === "effective").map((e) => e.to))
    : null;
  const effectiveSourceIds = graphLayer === "effective"
    ? new Set(graph.edges.filter((e) => e.kind === "effective").map((e) => e.from))
    : null;
  const hasEffectiveEdges = Boolean(effectiveResourceIds?.size || effectiveSourceIds?.size);

  const visibleNodes = [...nodesById.values()].filter((node) => {
    if (node.kind === "model_resource_type") return true;
    if (node.kind === "model_relation_stack" || node.kind === "model_permission_stack") return graphLayer === "model";
    if (node.kind === "model_relation" || node.kind === "model_permission") return false;
    if (graphLayer === "effective") {
      if (!hasEffectiveEdges) {
        if (node.kind === "user") return showUsers;
        if (hiddenTypes.has(node.kind)) return false;
        return true;
      }
      if (effectiveSourceIds?.has(node.id)) return true;
      // Show selected/source principals plus reachable resource nodes; hide
      // inherited usersets unless they are the only source for a resource view.
      if (node.kind === "team" || node.kind === "userset") return false;
      if (node.kind === "user") return showUsers;
      if (hiddenTypes.has(node.kind)) return false;
      return effectiveResourceIds?.has(node.id) ?? false;
    }
    if (node.kind === "team" || node.kind === "userset") return true;
    if (node.kind === "user") return showUsers;
    return true;
  });

  const visibleIds = new Set(visibleNodes.map((n) => n.id));

  // Use dagre for automatic graph layout; model topology reads better top-to-bottom
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: graphLayer === "model" ? "TB" : "LR", nodesep: 40, ranksep: 80, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of visibleNodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  for (const edge of graph.edges) {
    if (visibleIds.has(edge.from) && visibleIds.has(edge.to)) {
      g.setEdge(edge.from, edge.to);
    }
  }

  dagre.layout(g);

  return visibleNodes.map((node) => {
    const pos = g.node(node.id);
    return {
      id: node.id,
      type: "rebac",
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      data: {
        label: node.label,
        kind: node.kind,
        object: node.object ?? node.id,
        items: node.items,
      },
    };
  });
}

function buildFlowEdges(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  visibleNodeIds: Set<string>,
  graphLayer: GraphLayer,
  hiddenTypes: Set<string> = new Set()
): Edge<RebacEdgeData>[] {
  const persistedEdges = graph.edges
    .filter((edge) => {
      if (!visibleNodeIds.has(edge.from) || !visibleNodeIds.has(edge.to)) return false;
      // For the effective layer only show effective edges — hide raw tuple edges
      // (team membership, userset→resource) so the graph reads as user→resource.
      if (graphLayer === "effective") {
        const targetType = edge.to.split(":")[0];
        if (hiddenTypes.has(targetType)) return false;
        return edge.kind === "effective";
      }
      return true;
    })
    .map((edge) => {
      const isMetadata = edge.kind === "metadata";
      const isEffective = edge.kind === "effective";
      const isModel = edge.kind === "model";
      const featureStatusStyle = edge.status === "blocked"
        ? { stroke: "#ef4444", strokeWidth: 3 }
        : edge.status === "unknown"
          ? { stroke: "#f59e0b", strokeWidth: 2.5, strokeDasharray: "6 4" }
          : edge.status === "not_enforced"
            ? { stroke: "#94a3b8", strokeWidth: 2.5, strokeDasharray: "3 4" }
            : edge.status === "skipped"
              ? { stroke: "#64748b", strokeWidth: 2, strokeDasharray: "2 6" }
              : null;
      return {
        id: edge.id,
        source: edge.from,
        target: edge.to,
        label: isMetadata ? `${edge.relation} (metadata)` : isEffective ? edge.relation : edge.relation,
        data: { metadata: edge.metadata },
        labelStyle: { fontSize: 11, fill: "hsl(var(--foreground))" },
        labelBgStyle: { fill: "hsl(var(--card))", fillOpacity: 0.95 },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 6,
        style: featureStatusStyle ?? (isMetadata
          ? { stroke: "hsl(var(--muted-foreground))", strokeWidth: 2, strokeDasharray: "4 4" }
          : isEffective
            ? { stroke: "#10b981", strokeWidth: 2.5 }
            : isModel
              ? { stroke: "#60a5fa", strokeWidth: 2, strokeDasharray: "3 3" }
              : { stroke: "hsl(var(--primary))", strokeWidth: 2 }),
      } satisfies Edge<RebacEdgeData>;
    });

  const modelStackEdges = graphLayer === "model" ? buildModelStackEdges(visibleNodeIds) : [];
  return [...persistedEdges, ...modelStackEdges];
}

function buildModelStackEdges(visibleNodeIds: Set<string>): Edge<RebacEdgeData>[] {
  return [...visibleNodeIds].flatMap((nodeId) => {
    if (!nodeId.startsWith("model:resource_type:")) return [];
    const modelType = modelTypeFromNodeId(nodeId);
    if (!modelType) return [];

    const relationStackId = `model:relation_stack:${modelType}`;
    const permissionStackId = `model:permission_stack:${modelType}`;
    const edges: Edge<RebacEdgeData>[] = [];
    if (visibleNodeIds.has(relationStackId)) {
      edges.push({
        id: `model-stack-${modelType}-relations`,
        source: nodeId,
        target: relationStackId,
        label: "relations",
        data: { metadata: undefined },
        labelStyle: { fontSize: 11, fill: "hsl(var(--foreground))" },
        labelBgStyle: { fill: "hsl(var(--card))", fillOpacity: 0.95 },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 6,
        style: { stroke: "#60a5fa", strokeWidth: 2, strokeDasharray: "3 3" },
      });
    }
    if (visibleNodeIds.has(permissionStackId)) {
      edges.push({
        id: `model-stack-${modelType}-permissions`,
        source: visibleNodeIds.has(relationStackId) ? relationStackId : nodeId,
        target: permissionStackId,
        label: "permissions",
        data: { metadata: undefined },
        labelStyle: { fontSize: 11, fill: "hsl(var(--foreground))" },
        labelBgStyle: { fill: "hsl(var(--card))", fillOpacity: 0.95 },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 6,
        style: { stroke: "#60a5fa", strokeWidth: 2, strokeDasharray: "3 3" },
      });
    }
    return edges;
  });
}

function OpenFgaGraphControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const buttonClass =
    "flex h-8 w-8 items-center justify-center rounded-md text-primary transition-colors hover:bg-primary/15";

  return (
    <Panel position="bottom-left">
      <div className="flex flex-col gap-0.5 rounded-lg border bg-card p-1 shadow-lg">
        <button type="button" onClick={() => zoomIn()} className={buttonClass} title="Zoom in">
          +
        </button>
        <button type="button" onClick={() => zoomOut()} className={buttonClass} title="Zoom out">
          -
        </button>
        <div className="my-0.5 h-px bg-border" />
        <button type="button" onClick={() => fitView({ padding: 0.3 })} className={buttonClass} title="Fit view">
          fit
        </button>
      </div>
    </Panel>
  );
}

function RebacGraphNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as RebacNodeData;
  const meta = graphKindMeta(nodeData.kind);
  const Icon = meta.icon;

  return (
    <div
      className={cn(
        "w-[210px] rounded-lg border-2 bg-card px-3 py-2 shadow-sm transition-all",
        meta.className,
        selected && "ring-2 ring-primary/40"
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2 !border-background !bg-primary" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Badge variant="secondary" className="mb-1 gap-1 text-[10px]">
            <Icon className="h-3 w-3" aria-hidden="true" />
            {meta.label}
          </Badge>
          <div className="truncate text-sm font-medium">{nodeData.label}</div>
          <code className="block truncate text-[10px] text-muted-foreground">{nodeData.object}</code>
          {Array.isArray(nodeData.items) && nodeData.items.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {nodeData.items.slice(0, 6).map((item) => (
                <span key={item} className="rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {item}
                </span>
              ))}
              {nodeData.items.length > 6 && (
                <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  +{nodeData.items.length - 6} more
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-background !bg-primary" />
    </div>
  );
}

const RebacGraphNode = memo(RebacGraphNodeComponent);
const GRAPH_NODE_TYPES = { rebac: RebacGraphNode };

function EffectiveAccessCards({
  graph,
  subject,
  emptyMessage,
}: {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  subject: { id: string; username?: string; email?: string; firstName?: string; lastName?: string };
  emptyMessage?: string;
}) {
  const accessMap = buildAccessMap(graph);
  const grouped = groupAccessByType(accessMap);
  const totalResources = accessMap.size;

  if (totalResources === 0) {
    return (
      <div className="rounded-md border p-4 text-center text-sm text-muted-foreground">
        {emptyMessage ?? "No accessible resources found for this actor."}
      </div>
    );
  }

  return (
    <div className="space-y-4 border-t pt-4">
      <div>
        <h3 className="text-sm font-semibold">Access Summary</h3>
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{graphUserLabel(subject)}</span> can access{" "}
          <span className="font-medium text-foreground">{totalResources}</span>{" "}
          {totalResources === 1 ? "resource" : "resources"} across{" "}
          <span className="font-medium text-foreground">{grouped.size}</span>{" "}
          {grouped.size === 1 ? "type" : "types"}.
        </p>
      </div>
      {sortedAccessGroupEntries(grouped).map(([type, resources]) => (
        <AccessResourceGroup key={type} type={type} resources={resources} />
      ))}
    </div>
  );
}

function AccessResourceGroup({ type, resources }: { type: string; resources: ResourceAccess[] }) {
  const meta = resourceCardMeta(type);
  const Icon = meta.icon;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h4 className="text-sm font-semibold">{meta.label}s</h4>
        <Badge variant="secondary" className="text-xs">{resources.length}</Badge>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {resources.map((access) => (
          <AccessResourceCard key={access.node.id} access={access} type={type} />
        ))}
      </div>
    </div>
  );
}

function AccessResourceCard({ access, type }: { access: ResourceAccess; type: string }) {
  const meta = resourceCardMeta(type);
  const directGrants = access.grants.filter((g) => g.via === "direct");
  const inheritedGrants = access.grants.filter((g) => g.via !== "direct");
  const allRelations = [...new Set(access.grants.map((g) => g.relation))];
  const byVia = new Map<string, string[]>();
  for (const g of inheritedGrants) {
    const existing = byVia.get(g.via) ?? [];
    if (!existing.includes(g.relation)) existing.push(g.relation);
    byVia.set(g.via, existing);
  }
  return (
    <div className={cn("rounded-lg border-2 p-3 space-y-2", meta.className)}>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{access.node.label}</div>
        <code className="block truncate text-[10px] text-muted-foreground">{access.node.id}</code>
      </div>
      <div className="flex flex-wrap gap-1">
        {allRelations.map((rel) => (
          <Badge key={rel} variant="secondary" className="text-[10px] px-1.5 py-0.5">{rel}</Badge>
        ))}
      </div>
      <div className="space-y-0.5">
        {directGrants.length > 0 && (
          <p className="text-[10px] text-muted-foreground">
            Direct: {directGrants.map((g) => g.relation).join(", ")}
          </p>
        )}
        {[...byVia.entries()].map(([via, relations]) => (
          <p key={via} className="text-[10px] text-muted-foreground truncate">
            {via}: {relations.join(", ")}
          </p>
        ))}
      </div>
    </div>
  );
}

function ResourceTypeFilter({
  availableTypes,
  hiddenTypes,
  onToggle,
}: {
  availableTypes: [string, number][];
  hiddenTypes: Set<string>;
  onToggle: (type: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="shrink-0 text-xs text-muted-foreground">Show:</span>
      {availableTypes.map(([type, count]) => {
        const meta = graphKindMeta(type);
        const Icon = meta.icon;
        const active = !hiddenTypes.has(type);
        return (
          <button
            key={type}
            type="button"
            onClick={() => onToggle(type)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-all",
              active
                ? "border-transparent bg-muted text-foreground hover:bg-muted/70"
                : "border-border bg-background text-muted-foreground opacity-40 hover:opacity-60"
            )}
            title={active ? `Hide ${meta.label}s` : `Show ${meta.label}s`}
          >
            <Icon className="h-3 w-3" />
            {meta.label}
            <span className="rounded-full bg-background/60 px-1.5 py-0.5 text-[10px] tabular-nums">
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MetricCard({ label, value, testId }: { label: string; value: number; testId?: string }) {
  return (
    <div className="rounded-md border p-3" data-testid={testId}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}
