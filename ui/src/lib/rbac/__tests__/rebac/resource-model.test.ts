import {
  getResourceTypeDefinition,
  isSupportedResourceAction,
  listResourceTypeDefinitions,
  STANDARD_REBAC_ACTIONS,
} from "../../resource-model";
import { isUniversalRebacResourceType, validateRelationship } from "../../relationship-validator";

describe("universal ReBAC resource model", () => {
  it("defines the standard action vocabulary from the identity group ReBAC spec", () => {
    expect(STANDARD_REBAC_ACTIONS).toEqual([
      "discover",
      "read",
      "use",
      "write",
      "create",
      "delete",
      "manage",
      "administer",
      "audit",
      "approve",
      "share",
    ]);
  });

  it("catalogs every protected resource type required by the authorization matrix", () => {
    const resourceTypes = listResourceTypeDefinitions().map((definition) => definition.type);

    expect(resourceTypes).toEqual([
      "organization",
      "user",
      "user_profile",
      "external_group",
      "team",
      "slack_workspace",
      "slack_channel",
      "webex_workspace",
      "webex_space",
      "agent",
      "llm_model",
      "mcp_gateway",
      "mcp_server",
      "tool",
      "rag_collection",
      "knowledge_base",
      "data_source",
      "mcp_tool",
      "ingestion_source",
      "document",
      "skill",
      "task",
      "conversation",
      "admin_surface",
      "policy",
      "audit_log",
      "secret_ref",
      "system_config",
    ]);
  });

  it("exposes supported actions per resource type", () => {
    expect(getResourceTypeDefinition("slack_channel")?.actions).toEqual([
      "discover",
      "read",
      "use",
      "write",
      "manage",
      "audit",
    ]);
    expect(isSupportedResourceAction("knowledge_base", "ingest")).toBe(true);
    expect(isSupportedResourceAction("mcp_gateway", "call")).toBe(true);
    expect(isSupportedResourceAction("tool", "call")).toBe(true);
    expect(isSupportedResourceAction("mcp_server", "invoke")).toBe(true);
    expect(isSupportedResourceAction("mcp_server", "create")).toBe(true);
    expect(isSupportedResourceAction("llm_model", "write")).toBe(true);
    expect(isSupportedResourceAction("user_profile", "read")).toBe(true);
    expect(isSupportedResourceAction("user_profile", "create")).toBe(true);
    expect(isSupportedResourceAction("secret_ref", "use")).toBe(true);
    expect(isSupportedResourceAction("secret_ref", "manage")).toBe(true);
    expect(isSupportedResourceAction("secret_ref", "share")).toBe(true);
    expect(isSupportedResourceAction("secret_ref", "audit")).toBe(true);
    expect(isSupportedResourceAction("knowledge_base", "share")).toBe(false);
    expect(isSupportedResourceAction("organization", "automate")).toBe(true);
    expect(isSupportedResourceAction("agent", "automate")).toBe(false);
  });

  it("validates relationships and explains unsupported actions", () => {
    expect(
      validateRelationship({
        subject: { type: "team", id: "platform-engineering", relation: "member" },
        action: "use",
        resource: { type: "agent", id: "incident-triage" },
      })
    ).toEqual({ valid: true });

    expect(
      validateRelationship({
        subject: { type: "team", id: "platform-engineering", relation: "member" },
        action: "approve",
        resource: { type: "tool", id: "jira_create_issue" },
      })
    ).toEqual({
      valid: false,
      reason: "Resource type tool does not support action approve",
      code: "unsupported_action",
    });
  });

  it("recognizes resource types even when they do not support the literal read action", () => {
    expect(isUniversalRebacResourceType("secret_ref")).toBe(true);
    expect(isUniversalRebacResourceType("unknown")).toBe(false);
  });
});
