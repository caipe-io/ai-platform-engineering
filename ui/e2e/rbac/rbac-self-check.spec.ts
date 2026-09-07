// assisted-by Codex Codex-sonnet-4-6

import { expect,test } from "@playwright/test";

import {
  fulfillJson,
  installMockedRbacApp,
  mockedRbacEnabled,
  type MockRouteHandler,
} from "./_mocked-rbac";

const adminSession = {
  email: "sraradhy@cisco.com",
  name: "Sri Aradhyula",
  role: "admin" as const,
  canViewAdmin: true,
};

const driftReport = {
  generated_at: "2026-06-27T16:00:00.000Z",
  status: "fail",
  inventory: {
    mongo: {
      teams: 628,
      active_membership_sources_with_subject: 1451,
      dynamic_agents: 11,
      mcp_servers: 17,
      llm_models: 3,
      service_accounts: 2,
      slack_channel_grants: 16,
      slack_channel_team_mappings: 0,
      webex_space_grants: 19,
      webex_space_team_mappings: 0,
      credential_secret_refs: 5,
      conversations: 143,
      sharing_access: 3,
      skills: 4,
      tasks: 0,
      mcp_tool_catalog: 5,
    },
    openfga_tuple_count: 1972,
    openfga_tuples_by_object_type: { agent: 28, team: 1451, tool: 12 },
    organization_capability_tuples: ["team:super-admins#admin admin organization:caipe"],
  },
  summary: {
    expected_tuples: 183,
    missing_tuples: 4,
    stale_references: 2,
    orphan_candidates: 1,
    repairable_findings: 4,
    total_findings: 7,
  },
  expected_by_source: {
    team_membership_sources: 1451,
    "dynamic_agents.allowed_tools": 11,
    "service_accounts.scopes_snapshot": 3,
  },
  missing_by_source: {
    team_membership_sources: 1,
    "dynamic_agents.allowed_tools": 3,
  },
  findings: [
    {
      id: "missing-team-member",
      severity: "missing",
      source: "team_membership_sources",
      title: "Missing team membership tuple",
      detail: "user:1e4e8827-f0d9-48ea-816c-fb11471417eb admin team:super-admins",
      fix: "Repair the active team membership source into OpenFGA.",
      tuple: {
        user: "user:1e4e8827-f0d9-48ea-816c-fb11471417eb",
        relation: "admin",
        object: "team:super-admins",
      },
      repairable: true,
    },
    {
      id: "missing-agent-tool",
      severity: "missing",
      source: "dynamic_agents.allowed_tools",
      title: "Missing dynamic agents.allowed tools tuple",
      detail: "agent:agent-sre-agent caller tool:github/*",
      fix: "Replay agent reconciliation; this writes owner/team/global grants and agent-to-tool caller tuples.",
      tuple: {
        user: "agent:agent-sre-agent",
        relation: "caller",
        object: "tool:github/*",
      },
      repairable: true,
    },
    {
      id: "stale-service-account-agent",
      severity: "stale_reference",
      source: "service_accounts.scopes_snapshot",
      title: "Service account scope references missing agent agent-private",
      detail: "CI Robot still has an agent scope for agent-private, but that agent is not in dynamic_agents.",
      fix: "Remove the stale scope from the service account or restore the missing agent.",
      repairable: false,
    },
    {
      id: "orphan-review",
      severity: "orphan_candidate",
      source: "openfga",
      title: "Stale Slack channel team grant",
      detail: "team:old#member user slack_channel:CAIPE--C123. Current mapped team: platform",
      fix: "The channel-team mapping changed.",
      tuple: {
        user: "user:old",
        relation: "user",
        object: "agent:deleted-agent",
      },
      repairable: false,
      review_action: {
        type: "revoke_tuple",
        label: "Revoke tuple",
        reason: "No current source-of-truth record in this audit owns the tuple.",
      },
    },
  ],
  repair_batches: [
    {
      source: "team_membership_sources",
      finding_count: 1,
      repairable_count: 1,
      action_label: "team membership sources",
      guidance: "Repair the active team membership source into OpenFGA.",
    },
    {
      source: "dynamic_agents.allowed_tools",
      finding_count: 3,
      repairable_count: 3,
      action_label: "dynamic agents",
      guidance: "Replay agent reconciliation; this writes owner/team/global grants and agent-to-tool caller tuples.",
    },
  ],
  notes: [
    "Repair writes only base tuples such as user, caller, reader, manager, owner, owner_team, and writer.",
    "Stale references are not repaired automatically because writing tuples would resurrect access to deleted or missing resources.",
  ],
};

const healthyReport = {
  ...driftReport,
  status: "pass",
  summary: {
    expected_tuples: 183,
    missing_tuples: 0,
    stale_references: 0,
    orphan_candidates: 0,
    repairable_findings: 0,
    total_findings: 0,
  },
  findings: [],
  repair_batches: [],
};

const matrixReport = {
  generated_at: "2026-06-27T16:10:00.000Z",
  status: "pass",
  self_check_status: "pass",
  summary: {
    suites: 2,
    cases: 3,
    checks: 5,
    passed: 4,
    failed: 0,
    blocked: 0,
    skipped: 1,
    duration_ms: 22,
  },
  actors: [
    {
      key: "org_admin",
      label: "Current admin",
      subject_type: "user",
      subject_id: "admin-sub",
      source: "session",
      resolved: true,
      team_slugs: [],
    },
    {
      key: "member_user",
      label: "Non-admin member",
      subject_type: "user",
      subject_id: "member-sub",
      source: "inventory",
      resolved: true,
      team_slugs: ["platform"],
    },
    {
      key: "service_account",
      label: "Service account",
      subject_type: "service_account",
      subject_id: "sa-linked",
      source: "inventory",
      resolved: true,
      team_slugs: [],
    },
    {
      key: "unlinked_service_account",
      label: "Unlinked service account",
      subject_type: "service_account",
      subject_id: "sa-unlinked",
      source: "inventory",
      resolved: true,
      team_slugs: [],
    },
  ],
  suites: [
    {
      id: "credentials",
      label: "Credentials",
      description: "Credential checks",
      status: "pass",
      cases: [
        {
          id: "credentials:shared",
          title: "Shared credential",
          status: "pass",
          checks: [
            {
              id: "credentials:shared:metadata",
              title: "Shared credential metadata",
              status: "pass",
              detail: "Non-admin member can read-metadata secret_ref:shared as expected.",
            },
          ],
        },
      ],
    },
    {
      id: "service_accounts",
      label: "Service accounts",
      description: "Service account checks",
      status: "pass",
      cases: [
        {
          id: "service_accounts:gateway",
          title: "Gateway baseline",
          status: "pass",
          checks: [
            {
              id: "service_accounts:linked:gateway",
              title: "Linked service account can call gateway list",
              status: "pass",
              detail: "Service account can call mcp_gateway:list as expected.",
            },
          ],
        },
      ],
    },
  ],
  notes: [
    "The API matrix is read-only; it never creates, repairs, or revokes tuples.",
  ],
};

async function installRbacSelfCheckMocks(page: Parameters<typeof installMockedRbacApp>[0]) {
  const requests: string[] = [];
  const handler: MockRouteHandler = async ({ route,path,method }) => {
    if (path === "/api/admin/rebac/self-check/tests") {
      requests.push("MATRIX");
      await fulfillJson(route, { success: true, data: matrixReport });
      return true;
    }
    if (path !== "/api/admin/rebac/self-check") return false;
    requests.push(method);
    if (method === "POST") {
      let body: { action?: string } = {};
      try {
        body = route.request().postDataJSON() as { action?: string };
      } catch {
        body = {};
      }
      if (body.action === "revoke_tuples") {
        await fulfillJson(route, {
          success: true,
          data: {
            bulk_revoke: {
              requested_deletes: 1,
              attempted_deletes: 1,
              applied_deletes: 1,
              skipped_deletes: 0,
            },
            report: healthyReport,
          },
        });
        return true;
      }
      await fulfillJson(route, {
        success: true,
        data: {
          repair: {
            requested_sources: [],
            attempted_writes: 4,
            applied_writes: 4,
            skipped_findings: 3,
          },
          report: healthyReport,
        },
      });
      return true;
    }
    await fulfillJson(route, { success: true, data: driftReport });
    return true;
  };

  await installMockedRbacApp(page, {
    isAdmin: true,
    session: adminSession,
    handlers: [handler],
  });

  return requests;
}

test.describe("mocked RBAC Self Check browser regression", () => {
  test.beforeEach(() => {
    test.skip(
      !mockedRbacEnabled(),
      "Set RUN_RBAC_REGRESSION=1 to run the mocked RBAC browser regression.",
    );
  });

  test("surfaces OpenFGA drift and repairs safe missing tuples", async ({ page }) => {
    const requests = await installRbacSelfCheckMocks(page);

    await page.goto("/admin/security/self-check", {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByRole("button", { name: "Security & Policy" })).toHaveAttribute("data-active", "true");
    await expect(
      page
        .getByRole("navigation",{ name: "Admin sections" })
        .getByRole("link", { name: "Self Check" }),
    ).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByTestId("rbac-self-check-tab")).toBeVisible();
    await expect(page.getByText("Drift detected")).toBeVisible();
    await expect(page.getByText("Missing team membership tuple")).toBeVisible();
    await expect(page.getByText("agent:agent-sre-agent caller tool:github/*").first()).toBeVisible();
    await expect(page.getByText("Service account scope references missing agent agent-private")).toBeVisible();
    await expect(page.getByRole("button", { name: "Revoke tuple" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Select reviewable" })).toBeVisible();
    await expect(page.getByText("Repair Plan")).toBeVisible();

    await page.getByRole("button", { name: "Repair Missing Tuples" }).click();

    await expect(page.getByText("Healthy")).toBeVisible();
    await expect(page.getByText("repaired 4/4")).toBeVisible();
    await expect(page.getByText("No RBAC/OpenFGA drift found in the audited source records.")).toBeVisible();
    expect(requests).toEqual(["GET", "POST"]);
  });

  test("bulk revokes selected unowned OpenFGA tuples", async ({ page }) => {
    const requests = await installRbacSelfCheckMocks(page);

    await page.goto("/admin/security/self-check", {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByText("Stale Slack channel team grant")).toBeVisible();
    await page.getByRole("button", { name: "Select reviewable" }).click();
    await expect(page.getByText("1/1 selected")).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Revoke selected" }).click();

    await expect(page.getByText("Healthy")).toBeVisible();
    await expect(page.getByText("revoked 1/1")).toBeVisible();
    await expect(page.getByText("No RBAC/OpenFGA drift found in the audited source records.")).toBeVisible();
    expect(requests).toEqual(["GET", "POST"]);
  });

  test("runs the RBAC API matrix from the UI", async ({ page }) => {
    const requests = await installRbacSelfCheckMocks(page);

    await page.goto("/admin/security/self-check", {
      waitUntil: "domcontentloaded",
    });

    await expect(page.getByText("API Access Matrix")).toBeVisible();
    await page.getByRole("button", { name: "Run Access Matrix" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Matrix tests")).toBeVisible();
    await expect(dialog.getByText(/Current admin: user/)).toBeVisible();
    await dialog.getByText("Credentials", { exact: true }).click();
    await dialog.getByText("Shared credential", { exact: true }).click();
    await expect(dialog.getByText("Shared credential metadata")).toBeVisible();
    await dialog.getByText("Service accounts", { exact: true }).click();
    await dialog.getByText("Gateway baseline", { exact: true }).click();
    await expect(dialog.getByText("Linked service account can call gateway list")).toBeVisible();
    await expect(page.getByText("Passed").first()).toBeVisible();
    await expect(page.getByText("Skipped").first()).toBeVisible();
    expect(requests).toEqual(["GET", "MATRIX"]);
  });
});
