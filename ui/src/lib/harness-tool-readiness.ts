import { getCollection } from "@/lib/mongodb";
import type { AgentExecutionReadiness } from "@/types/dynamic-agent";

export const CLAUDE_TOOL_RUNTIMES = new Set(["claude_agent_sdk", "claude_agent_sdk_remote", "claude_code_acp", "claude_code_cli_acp"]);
type Agent = { _id: string; execution_harness_id?: string; allowed_tools?: Record<string, string[] | boolean> };
type Server = { _id: string; enabled?: boolean };
const blocked = (message: string): AgentExecutionReadiness => ({ ready: false, code: "HARNESS_AGENT_NOT_READY", message });

/** Metadata only: never probe providers, disclose credentials, or change grants. */
export async function getHarnessToolReadiness(agents: Agent[], pinnedTools?: string[]): Promise<Map<string, AgentExecutionReadiness>> {
  const relevant = agents.filter(agent => CLAUDE_TOOL_RUNTIMES.has(agent.execution_harness_id ?? ""));
  const result = new Map<string, AgentExecutionReadiness>();
  if (!relevant.length) return result;
  const requiresTools = pinnedTools?.length || relevant.some(agent => Object.values(agent.allowed_tools ?? {}).some(value => value !== false));
  const servers = requiresTools ? await (await getCollection<Server>("mcp_servers")).find({}, { projection: { _id: 1, enabled: 1 } }).toArray() : [];
  for (const agent of relevant) {
    const allowed = agent.allowed_tools ?? {};
    const serverIds = pinnedTools === undefined ? Object.keys(allowed).filter(id => allowed[id] !== false) : pinnedTools.map(tool => {
      const server = servers.filter(item => tool.startsWith(`${item._id}.`)).sort((a, b) => b._id.length - a._id.length)[0];
      return server?._id ?? "";
    });
    const missing = serverIds.some(id => !servers.some(server => server._id === id && server.enabled !== false));
    const revoked = pinnedTools?.some((tool, index) => {
      const id = serverIds[index]; const grant = allowed[id]; const name = tool.slice(id.length + 1);
      return !(grant === true || Array.isArray(grant) && (!grant.length || grant.includes(name)));
    });
    result.set(agent._id, missing ? blocked("This agent selects an MCP server that is disabled or missing. Ask the agent owner to update its tools before starting a new turn. Nothing was executed.")
      : revoked ? blocked("This conversation's saved tools are no longer allowed for this agent. Ask the agent owner to reconcile its configuration before starting a new turn. Nothing was executed.") : { ready: true });
  }
  return result;
}
