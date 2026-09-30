// assisted-by claude code claude-sonnet-4-6
//
// compose() wraps a PolicyEngine with product policy that cannot live in
// OpenFGA tuples (e.g. workflow-scoped delegation, channel visibility).
// Returns a PolicyEngine — callers see no seam.

import type { Action, AuthorizeRequest, AuthorizeResult, ResourceType, Subject } from "./contract";
import type { ListObjectsResult, PolicyEngine } from "./engine";

export interface ProductPolicyOptions {
  /**
   * Called before the PDP for each check. Return a result to short-circuit
   * (e.g. an org-admin bypass or a workflow-scoped delegation). Return null
   * to fall through to the PDP.
   */
  preCheck?: (req: AuthorizeRequest) => Promise<AuthorizeResult | null>;
}

export function compose(engine: PolicyEngine, opts: ProductPolicyOptions = {}): PolicyEngine {
  return {
    async check(req: AuthorizeRequest): Promise<AuthorizeResult> {
      if (opts.preCheck) {
        const override = await opts.preCheck(req);
        if (override) return override;
      }
      return engine.check(req);
    },

    async batchCheck(
      subject: Subject,
      action: Action,
      resourceType: ResourceType,
      ids: string[],
    ): Promise<Map<string, AuthorizeResult>> {
      if (!opts.preCheck) {
        return engine.batchCheck(subject, action, resourceType, ids);
      }
      // Apply preCheck per-id; batch remaining to the engine.
      const overrides = new Map<string, AuthorizeResult>();
      const passthrough: string[] = [];

      await Promise.all(
        ids.map(async (id) => {
          const req: AuthorizeRequest = { subject, action, resource: { type: resourceType, id } };
          const override = await opts.preCheck!(req);
          if (override) {
            overrides.set(id, override);
          } else {
            passthrough.push(id);
          }
        }),
      );

      const engineResults = passthrough.length > 0
        ? await engine.batchCheck(subject, action, resourceType, passthrough)
        : new Map<string, AuthorizeResult>();

      return new Map([...overrides, ...engineResults]);
    },

    // listObjects computes a set from the relationship graph directly — there
    // is no per-candidate AuthorizeRequest for preCheck to intercept, so a
    // product-policy override (e.g. workflow delegation) cannot participate.
    // Safe today: no current preCheck implementation is reachable through the
    // batch path either (compose's own batchCheck builds requests with no
    // trustedContext, and workflowDelegationPreCheck requires one) — see
    // ui/src/lib/authz/domains/workflow.ts. If that ever changes for a
    // resource/action this is used for, this engine's listObjects must not be
    // called for that pair without a corresponding preCheck-equivalent here.
    listObjects(subject: Subject, action: Action, resourceType: ResourceType): Promise<ListObjectsResult> {
      return engine.listObjects(subject, action, resourceType);
    },
  };
}
