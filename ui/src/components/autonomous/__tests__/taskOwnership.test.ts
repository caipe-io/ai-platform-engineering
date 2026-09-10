// Copyright CAIPE Contributors (https://caipe.io)
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the editor's "is this task mine?" predicate.
 *
 * Why this matters
 * ----------------
 * After the dynamic-agent routing rename, custom-agent tasks are
 * stamped as ``dynamic_agent_id: <id>, agent: null`` -- the previous
 * filter (``t.agent === agentId``) silently dropped every row, which
 * surfaced as "No schedules yet" in the editor's Autonomous tab.
 * The predicate accepts either field so legacy rows keep showing
 * up without a Mongo backfill.
 */

import type { AutonomousTask } from "@/components/autonomous/types";

import { isTaskOwnedByAgent } from "../taskOwnership";

function task(overrides: Partial<AutonomousTask>): AutonomousTask {
  return {
    id: "t1",
    name: "t",
    description: null,
    agent: null,
    prompt: "p",
    llm_provider: null,
    trigger: { type: "cron", schedule: "0 9 * * *" },
    enabled: true,
    ...overrides,
  };
}

describe("isTaskOwnedByAgent", () => {
  it("matches on dynamic_agent_id (current stamping)", () => {
    expect(
      isTaskOwnedByAgent(
        task({ agent: null, dynamic_agent_id: "my_agent" }),
        "my_agent",
      ),
    ).toBe(true);
  });

  it("matches on legacy agent field (pre-rename rows)", () => {
    // Backfill story: tasks created before the rename still have
    // ``agent: <agent-id>`` -- the editor must still surface them so
    // operators don't get a phantom "No schedules yet" empty state
    // until Mongo gets manually patched.
    expect(
      isTaskOwnedByAgent(
        task({ agent: "my_agent", dynamic_agent_id: null }),
        "my_agent",
      ),
    ).toBe(true);
  });

  it("rejects tasks belonging to a different agent", () => {
    expect(
      isTaskOwnedByAgent(
        task({ agent: null, dynamic_agent_id: "other" }),
        "my_agent",
      ),
    ).toBe(false);
    expect(
      isTaskOwnedByAgent(
        task({ agent: "other", dynamic_agent_id: null }),
        "my_agent",
      ),
    ).toBe(false);
  });

  it("rejects tasks with neither field set (supervisor LLM-routed)", () => {
    expect(
      isTaskOwnedByAgent(
        task({ agent: null, dynamic_agent_id: null }),
        "my_agent",
      ),
    ).toBe(false);
  });
});
