import { redirect } from "next/navigation";

/**
 * Compatibility redirect for the retired AgentSkill execution-history page.
 * Skill execution and its retained run history remain available from Skills.
 */
export default function LegacyAgentBuilderHistoryRedirectPage(): never {
  redirect("/skills");
}
