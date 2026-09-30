import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { KeycloakMigrationHealthPanel } from "../KeycloakMigrationHealthPanel";

// Mock the Tooltip primitive so its content always renders inline in the
// test DOM (the real component portals into document.body on hover with
// a delay, which is awkward and racy under JSDOM). This mirrors the mock
// in `ui/src/components/layout/__tests__/AppHeader.test.tsx`.
jest.mock("@/components/ui/tooltip", () => {
  const TooltipTrigger = React.forwardRef(function MockTooltipTrigger(
    { children, asChild }: { children: React.ReactNode; asChild?: boolean },
    ref: React.Ref<HTMLElement>,
  ) {
    if (asChild && React.isValidElement(children)) {
      return children;
    }
    return (
      <span ref={ref as React.Ref<HTMLSpanElement>}>{children}</span>
    );
  });
  return {
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipContent: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="mock-tooltip-content">{children}</div>
    ),
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipTrigger,
  };
});

function jsonResponse(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

const failedHealth = {
  success: true,
  data: {
    keycloak: {
      configured: true,
      reachable: false,
      realm: "caipe",
      last_probe_at: "2026-05-19T12:00:00.000Z",
      probe_error: "Keycloak unavailable",
    },
    schema_area: {
      area: "keycloak_rbac_mappings",
      current_version: 0,
      target_version: 1,
      status: "behind",
      last_migration_id: "keycloak_rbac_mapping_reconciliation_v1",
    },
    migration: {
      id: "keycloak_rbac_mapping_reconciliation_v1",
      manifest_status: "failed",
      last_run: {
        status: "failed",
        actor: "webui-startup",
        updated_at: "2026-05-19T12:00:00.000Z",
        applied_counts: { obo_permission_sets_reconciled: 2, token_exchange_permissions_reconciled: 1 },
        planned_counts: {},
        warnings: ["Keycloak unavailable"],
        error: "Keycloak unavailable",
      },
    },
    blocking: {
      is_blocking: true,
      blocking_required_count: 1,
    },
    keycloak_values: {
      obo_permissions: [
        {
          bot_client_id: "caipe-slack-bot",
          policy_name: "caipe-slack-bot-token-exchange",
          bot_token_exchange_attached: true,
          users_impersonate_attached: true,
          target_audience_attached: true,
        },
      ],
      bot_service_accounts: [
        {
          client_id: "caipe-slack-bot",
          service_account_id: "sa-slack",
          impersonation_role_assigned: true,
        },
      ],
      token_exchange_permissions: [
        {
          client_id: "caipe-platform",
          decision_strategy: "AFFIRMATIVE",
          token_exchange_permission_id: "perm-1",
          policy_names: [
            "caipe-webex-bot-token-exchange",
            "caipe-slack-bot-token-exchange",
          ],
        },
      ],
    },
    bootstrap_admins: {
      enabled: true,
      configured_emails: ["admin@cisco.com"],
      resolved_count: 1,
      created_count: 0,
      failed_count: 0,
      tuple_write_count: 3,
      warnings: [],
      outcomes: [
        {
          email: "admin@cisco.com",
          user_id: "sub-admin",
          status: "existing",
          tuple_write_count: 3,
        },
      ],
    },
  },
};

const completedHealth = {
  success: true,
  data: {
    ...failedHealth.data,
    keycloak: {
      ...failedHealth.data.keycloak,
      reachable: true,
      probe_error: undefined,
    },
    schema_area: {
      ...failedHealth.data.schema_area,
      current_version: 1,
      status: "current",
    },
    migration: {
      ...failedHealth.data.migration,
      manifest_status: "completed",
      last_run: {
        ...failedHealth.data.migration.last_run,
        status: "completed",
        error: undefined,
        warnings: [],
      },
    },
    blocking: {
      is_blocking: false,
      blocking_required_count: 0,
    },
  },
};

describe("KeycloakMigrationHealthPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("lets admins reconcile a failed Keycloak migration and refreshes health", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(failedHealth))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: {
          applied_counts: { obo_permission_sets_reconciled: 2 },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(completedHealth));

    render(<KeycloakMigrationHealthPanel />);

    expect(await screen.findByText("Keycloak Reconciliation Health")).toBeInTheDocument();
    expect((await screen.findAllByText("Keycloak unavailable")).length).toBeGreaterThan(0);
    expect(screen.getByText("Keycloak URL configured")).toHaveClass("text-emerald-700");
    expect(screen.getByText("Keycloak unreachable")).toHaveClass("text-red-700");
    expect(screen.getByText("Schema behind")).toHaveClass("text-amber-700");
    expect(screen.getByText("v0 -> v1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Reconcile all/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/admin/rebac/migrations/keycloak_rbac_mapping_reconciliation_v1/apply",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ confirmation: "MIGRATE keycloak_rbac_mappings TO v1" }),
        }),
      );
    });
    expect(await screen.findByText(/Reconcile applied/i)).toBeInTheDocument();
    expect(screen.getByText("Keycloak reachable")).toHaveClass("text-emerald-700");
    expect(screen.getByText("Schema current")).toHaveClass("text-emerald-700");
  });

  it("labels admin API 403s separately from Keycloak network reachability", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({
      success: true,
      data: {
        ...failedHealth.data,
        keycloak: {
          ...failedHealth.data.keycloak,
          reachable: true,
          status: "admin_authorization_error",
          probe_error: "Keycloak Admin enableUsersManagementPermissions failed: 403 HTTP 403 Forbidden",
        },
      },
    }));

    render(<KeycloakMigrationHealthPanel />);

    expect(await screen.findByText("Keycloak admin unauthorized")).toHaveClass("text-red-700");
    expect(screen.queryByText("Keycloak unreachable")).not.toBeInTheDocument();
  });

  // The "applied_counts tile grid" was removed in 2026-05-24 — those
  // tiles (Mongo teams seen / Team scopes reconciled / OBO permission
  // sets reconciled / Bot service accounts reconciled / Token exchange
  // permissions reconciled / Active team defaults selected / Bootstrap
  // admin {resolved,placeholders,tuples,failures}) showed raw last-run
  // counters from the reconciliation algorithm, which are bookkeeping
  // noise once Keycloak is steady. The Invariants section below the
  // grid is now the single source of truth for "is Keycloak healthy",
  // with its own per-row Fix buttons. Raw counts are still persisted on
  // the migration record and exposed via the JSON API for anyone
  // debugging the migration itself.
  it("does not render the applied_counts tile grid for any reconciliation count", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(failedHealth));

    render(<KeycloakMigrationHealthPanel />);

    // Wait for the panel to render before asserting absence so we don't
    // race the initial fetch.
    expect(await screen.findByText("Keycloak Reconciliation Health")).toBeInTheDocument();

    // None of the previously-rendered counter tile labels should exist.
    // Each was a Metric tile with an "Inspect <label> metric" button —
    // those buttons are also gone now, so the inspect-values modal is
    // unreachable via the panel UI.
    const removedLabels = [
      "Mongo teams seen",
      "Team scopes reconciled",
      "OBO permission sets reconciled",
      "Bot service accounts reconciled",
      "Token exchange permissions reconciled",
      "Active team defaults selected",
    ];
    for (const label of removedLabels) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: new RegExp(`Inspect ${label} metric`, "i") }),
      ).not.toBeInTheDocument();
    }
    // The Inspect-values modal entry point is also gone — the modal
    // root itself should not be open at this point.
    expect(screen.queryByText("Keycloak values")).not.toBeInTheDocument();
  });

  it("renders bootstrap admin reconciliation diagnostics", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(completedHealth));

    render(<KeycloakMigrationHealthPanel />);

    expect(await screen.findByText("Bootstrap admins")).toBeInTheDocument();
    expect(screen.getByText("1/1 resolved")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Inspect Bootstrap admins metric/i }));

    expect(await screen.findByRole("dialog", { name: /Bootstrap admins details/i })).toBeInTheDocument();
    expect(screen.getByText("admin@cisco.com")).toBeInTheDocument();
    expect(screen.getByText("sub-admin")).toBeInTheDocument();
  });

  it("renders Keycloak invariants with pass/fail pills and remediation hints", async () => {
    // Hydrate a `completedHealth` fixture with a mixed-status invariants block
    // so we can assert the panel renders pass + fail groups, shows the
    // top-level summary pill, and surfaces the Reconcile now CTA when any
    // failing invariant is remediation=reconcile_now.
    const healthWithInvariants = {
      success: true,
      data: {
        ...completedHealth.data,
        keycloak_invariants: {
          summary: {
            total: 2,
            passing: 1,
            failing: 1,
            unknown: 0,
            reconcile_now_recommended: true,
          },
          items: [
            {
              id: "obo.users_impersonate.affirmative",
              description: "users.impersonate scope-permission uses AFFIRMATIVE strategy",
              group: "obo",
              source: "init-idp.sh",
              status: "fail",
              detail: "Current strategy: UNANIMOUS.",
              remediation: "reconcile_now",
            },
            {
              id: "obo.users_impersonate.policies_strict",
              description: "users.impersonate perm only has strict client allow-list policies",
              group: "obo",
              source: "init-idp.sh",
              status: "pass",
              remediation: "none",
            },
          ],
        },
      },
    };

    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(healthWithInvariants));

    render(<KeycloakMigrationHealthPanel />);

    // Section renders
    expect(await screen.findByTestId("keycloak-invariants")).toBeInTheDocument();

    // Top-row summary pill counts the failures
    expect(screen.getByText("1 invariant failing")).toBeInTheDocument();

    // The failing OBO row is visible (initial-open behavior on fail/unknown
    // groups), shows the inline Fix action, and renders its detail copy so
    // admins can read the remediation hint without expanding anything.
    const failingRow = await screen.findByTestId(
      "invariant-obo.users_impersonate.affirmative",
    );
    expect(failingRow).toHaveTextContent("AFFIRMATIVE strategy");
    expect(failingRow).toHaveTextContent("Fail");
    expect(failingRow).toHaveTextContent("Current strategy: UNANIMOUS.");
    // Per-row "Fix" button is present for reconcile_now invariants.
    expect(
      screen.getByTestId("invariant-fix-obo.users_impersonate.affirmative"),
    ).toHaveTextContent(/Fix/);

    // Reconcile-all CTA at the top of the card is visible because at least
    // one failing invariant has remediation=reconcile_now even though the
    // existing schema/migration state is healthy.
    expect(screen.getByRole("button", { name: /Reconcile all/i })).toBeInTheDocument();
  });

  // ─────────────────────────────────────────────────────────────
  // Plain-English invariant tooltip explainer.
  //
  // The cryptic machine IDs (e.g. `obo.token_exchange.shared_audience.affirmative`)
  // are accurate but not self-explanatory. Each row now renders a
  // HelpCircle affordance with a hover tooltip decoded by
  // `explainInvariant`. These assertions verify
  // (a) the affordance is present for EVERY row regardless of status,
  // (b) the tooltip body is decoded (not the raw ID), and
  // (c) the aria-label embeds the decoded title so screen readers and
  //     keyboard users get the same information without the hover.
  // ─────────────────────────────────────────────────────────────
  it("renders a plain-English explainer tooltip for every invariant row regardless of status", async () => {
    const healthWithMixedInvariants = {
      success: true,
      data: {
        ...completedHealth.data,
        keycloak_invariants: {
          summary: {
            total: 2,
            passing: 1,
            failing: 1,
            unknown: 0,
            reconcile_now_recommended: true,
          },
          items: [
            {
              id: "obo.token_exchange.shared_audience.affirmative",
              description: "caipe-platform token-exchange perm uses AFFIRMATIVE strategy",
              group: "obo",
              source: "init-idp.sh",
              status: "pass",
              remediation: "none",
            },
            {
              id: "obo.users_impersonate.exists",
              description: "Realm users.impersonate scope-permission exists",
              group: "obo",
              source: "init-idp.sh",
              status: "fail",
              detail: "Permission missing.",
              remediation: "reconcile_now",
            },
          ],
        },
      },
    };

    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(healthWithMixedInvariants));

    render(<KeycloakMigrationHealthPanel />);

    // (a) Affordance present for every row, including the passing one
    // (so users can hover *any* row to learn what it checks).
    expect(
      await screen.findByTestId("invariant-explain-obo.token_exchange.shared_audience.affirmative"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("invariant-explain-obo.users_impersonate.exists"),
    ).toBeInTheDocument();

    // (b) Tooltip body is the decoded explanation, not the raw ID. With
    // the mock that always renders TooltipContent, we can read the body
    // text directly. The passing AFFIRMATIVE row must explain WHY
    // AFFIRMATIVE is needed (not just repeat the description).
    const affirmativeRow = screen.getByTestId(
      "invariant-obo.token_exchange.shared_audience.affirmative",
    );
    expect(affirmativeRow.textContent ?? "").toMatch(/UNANIMOUS/);
    expect(affirmativeRow.textContent ?? "").toMatch(/both bot client-allowlist policies/i);

    // The failing users.impersonate row must reference the realm-wide
    // impersonation gate in plain English. The "keep both technical
    // and plain-English" wording style means the body now embeds the
    // technical client-id (`users.impersonate`) inline with the
    // `realm-level scope-permission` phrase, so we accept either
    // ordering.
    const existsRow = screen.getByTestId("invariant-obo.users_impersonate.exists");
    expect(existsRow.textContent ?? "").toMatch(
      /realm-level (?:`users\.impersonate` )?scope-permission/i,
    );
    expect(existsRow.textContent ?? "").toMatch(/no client.*can ever issue an OBO.*token/i);

    // (c) The hover affordance's aria-label embeds the decoded title so
    // screen-reader users get the same context without firing a hover.
    const affordance = screen.getByTestId(
      "invariant-explain-obo.token_exchange.shared_audience.affirmative",
    );
    const ariaLabel = affordance.getAttribute("aria-label") ?? "";
    expect(ariaLabel).toContain("caipe-platform token-exchange perm uses AFFIRMATIVE strategy");
    // The decoder's title is appended after the row description, so an
    // assistive technology user can hear both the "what" and the "why".
    expect(ariaLabel).toMatch(/AFFIRMATIVE decision strategy/);
  });

  it("fixes a single failing invariant by reusing the global migration endpoint", async () => {
    // A per-row "Fix" click should POST to the same migration apply endpoint
    // as the top-level "Reconcile all" button. The button is just an
    // ergonomic affordance to indicate which row prompted the run; the BFF
    // contract is unchanged.
    const healthWithFailingInvariant = {
      success: true,
      data: {
        ...completedHealth.data,
        keycloak_invariants: {
          summary: {
            total: 1,
            passing: 0,
            failing: 1,
            unknown: 0,
            reconcile_now_recommended: true,
          },
          items: [
            {
              id: "obo.users_impersonate.affirmative",
              description: "users.impersonate scope-permission uses AFFIRMATIVE strategy",
              group: "obo",
              source: "init-idp.sh",
              status: "fail",
              detail: "Current strategy: UNANIMOUS.",
              remediation: "reconcile_now",
            },
          ],
        },
      },
    };

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(healthWithFailingInvariant))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { applied_counts: { obo_permission_sets_reconciled: 1 } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(completedHealth));

    render(<KeycloakMigrationHealthPanel />);

    fireEvent.click(
      await screen.findByTestId("invariant-fix-obo.users_impersonate.affirmative"),
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/admin/rebac/migrations/keycloak_rbac_mapping_reconciliation_v1/apply",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ confirmation: "MIGRATE keycloak_rbac_mappings TO v1" }),
        }),
      );
    });

    expect(await screen.findByText(/Reconcile applied/i)).toBeInTheDocument();
  });

  it("offers a Copy diagnostics button that writes the full health payload", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    Object.defineProperty(window, "isSecureContext", {
      value: true,
      configurable: true,
    });

    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(completedHealth));

    render(<KeycloakMigrationHealthPanel />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: /Copy full Keycloak diagnostics JSON/i,
      }),
    );

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain('"realm": "caipe"');
    expect(copied).toContain('"manifest_status": "completed"');
  });

  it("keeps the last successful health payload without showing raw fetch failures", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(completedHealth))
      .mockRejectedValueOnce(new TypeError("fetch failed"));

    render(<KeycloakMigrationHealthPanel />);

    expect(await screen.findByText("Keycloak reachable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Refresh/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Keycloak reachable")).toBeInTheDocument();
    expect(screen.queryByText("fetch failed")).not.toBeInTheDocument();
  });

  it("marks health degraded when bootstrap admin reconciliation has failures", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({
      success: true,
      data: {
        ...completedHealth.data,
        bootstrap_admins: {
          ...completedHealth.data.bootstrap_admins,
          resolved_count: 0,
          failed_count: 1,
          tuple_write_count: 0,
          warnings: ["admin@cisco.com: OpenFGA is not configured"],
          outcomes: [
            {
              email: "admin@cisco.com",
              user_id: "sub-admin",
              status: "failed",
              tuple_write_count: 0,
              error: "OpenFGA is not configured",
            },
          ],
        },
      },
    }));

    render(<KeycloakMigrationHealthPanel />);

    expect(await screen.findByText("Bootstrap admin failures")).toHaveClass("text-amber-700");
    expect(screen.getByText("0/1 resolved")).toBeInTheDocument();
  });

  // ─────────────────────────────────────────────────────────────
  // Plain-English explainer tooltips for migration warnings and
  // bootstrap admin failures.
  //
  // The reconciliation pipeline can still surface ad-hoc warning
  // strings (e.g. from `keycloak-bootstrap-admins.ts`). Each row in
  // the migration "Warnings" bar must still get a HelpCircle
  // affordance — even unknown warning strings fall back to a generic
  // explainer so the panel never silently swallows them.
  //
  // Bootstrap admin failures keep a section-level explainer plus a
  // per-row explainer for each failed email (typo, OpenFGA
  // unreachable, profile policy too strict, email casing).
  // ─────────────────────────────────────────────────────────────
  it("renders a plain-English explainer tooltip on every migration warning row", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({
      success: true,
      data: {
        ...completedHealth.data,
        migration: {
          ...completedHealth.data.migration,
          last_run: {
            ...completedHealth.data.migration.last_run,
            warnings: [
              "Some brand new warning we haven't taught the decoder yet",
            ],
          },
        },
      },
    }));

    render(<KeycloakMigrationHealthPanel />);

    // The raw warning text is rendered verbatim and the explainer
    // augments it with the generic fallback body.
    await waitFor(() =>
      expect(
        screen.getByText(/brand new warning/i),
      ).toBeInTheDocument(),
    );

    const unknownTrigger = screen.getByTestId("migration-warning-explain-0");
    expect(unknownTrigger).toBeInTheDocument();
    expect(unknownTrigger.getAttribute("aria-label") ?? "").toMatch(/Migration warning/);
  });

  it("renders a section-level explainer on the Bootstrap admin header and a per-row explainer for each failed email", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({
      success: true,
      data: {
        ...completedHealth.data,
        bootstrap_admins: {
          ...completedHealth.data.bootstrap_admins,
          resolved_count: 0,
          failed_count: 2,
          tuple_write_count: 0,
          warnings: [
            "alice@example.com: user not found in Keycloak realm `caipe`",
            "bob@example.com: OpenFGA returned 502",
          ],
          outcomes: [
            {
              email: "alice@example.com",
              status: "failed",
              tuple_write_count: 0,
              error: "user not found in Keycloak realm `caipe`",
            },
            {
              email: "bob@example.com",
              status: "failed",
              tuple_write_count: 0,
              error: "OpenFGA returned 502",
            },
          ],
        },
      },
    }));

    render(<KeycloakMigrationHealthPanel />);

    // The amber header row must show the count AND a section-level
    // "?" affordance for the concept-of-bootstrap-admins explainer.
    await waitFor(() =>
      expect(
        screen.getByText(/Bootstrap admin reconciliation failed for 2 emails/i),
      ).toBeInTheDocument(),
    );
    const headerTrigger = screen.getByTestId("bootstrap-admin-header-explain");
    expect(headerTrigger).toBeInTheDocument();
    // Header tooltip explains the concept (not per-email) and
    // names both env-var variants and the OpenFGA dependency.
    const headerTooltipText =
      headerTrigger.parentElement?.textContent ?? "";
    expect(headerTooltipText).toMatch(/BOOTSTRAP_ADMIN_EMAILS/);
    expect(headerTooltipText).toMatch(/RBAC_BOOTSTRAP_ADMIN_EMAILS/);
    expect(headerTooltipText).toMatch(/empty Keycloak realm|locked out/i);

    // Each failed-email row gets its own per-row explainer with
    // the email interpolated into the title and the error into
    // the body.
    const row0 = screen.getByTestId("bootstrap-admin-warning-row-0");
    expect(row0).toHaveTextContent(/alice@example\.com:/);
    expect(row0).toHaveTextContent(/user not found in Keycloak realm/);
    const explain0 = screen.getByTestId("bootstrap-admin-warning-explain-0");
    expect(explain0.getAttribute("aria-label") ?? "").toMatch(/alice@example\.com/);

    const row1 = screen.getByTestId("bootstrap-admin-warning-row-1");
    expect(row1).toHaveTextContent(/bob@example\.com:/);
    expect(row1).toHaveTextContent(/OpenFGA returned 502/);
    const explain1 = screen.getByTestId("bootstrap-admin-warning-explain-1");
    expect(explain1.getAttribute("aria-label") ?? "").toMatch(/bob@example\.com/);

    // Per-row tooltip body must include the "How to fix" block
    // with at least a typo / policy / OpenFGA / casing hint.
    const row1Text = row1.textContent ?? "";
    expect(row1Text).toMatch(/How to fix:/);
    expect(row1Text).toMatch(/typo/i);
    expect(row1Text).toMatch(/KEYCLOAK_USER_PROFILE_UNMANAGED_ATTRIBUTE_POLICY/);
  });

  it("shows a friendly error when a refresh fetch fails with a transient network error", async () => {
    // First load succeeds (hasLoadedHealthRef becomes true), then a Refresh
    // throws TypeError: fetch failed — should show the friendly message
    // rather than silently doing nothing.
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(completedHealth))
      .mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), {}));

    render(<KeycloakMigrationHealthPanel />);

    // Wait for first load to finish — button is disabled while loading.
    const refreshBtn = screen.getByRole("button", { name: /Refresh/i });
    await waitFor(() => expect(refreshBtn).not.toBeDisabled());

    expect(screen.queryByText(/Failed to refresh/i)).not.toBeInTheDocument();

    fireEvent.click(refreshBtn);

    expect(await screen.findByText(/Failed to refresh.*connection error/i)).toBeInTheDocument();
  });

  it("surfaces the raw error on first load when the network is unreachable", async () => {
    // On the very first load hasLoadedHealthRef is false, so a transient
    // network failure must not be suppressed — the user needs to know the
    // panel never loaded.
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), {}));

    render(<KeycloakMigrationHealthPanel />);

    expect(await screen.findByText(/fetch failed/i)).toBeInTheDocument();
    expect(screen.queryByText(/Failed to refresh/i)).not.toBeInTheDocument();
  });
});
