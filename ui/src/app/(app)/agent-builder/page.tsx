import { redirect } from "next/navigation";

/**
 * Compatibility redirect for the retired Agentic Workflows gallery.
 *
 * The legacy page edited AgentSkill records, so the Skills Gallery is the
 * canonical replacement. This route intentionally does not point at the
 * Dynamic Agents editor or the separate multi-agent Workflows builder.
 */
export default function LegacyAgentBuilderRedirectPage(): never {
  redirect("/skills");
}
