// Copyright CAIPE Contributors (https://caipe.io)
// SPDX-License-Identifier: Apache-2.0

import type { AutonomousTask } from "../types";
import { EMPTY_FORM, fromFormState, summarizeTrigger, toFormState } from "../formState";

describe("formState.toFormState", () => {
  it("returns a blank form when task is null", () => {
    expect(toFormState(null)).toEqual(EMPTY_FORM);
  });

  it("maps a cron task to form fields", () => {
    const task: AutonomousTask = {
      id: "nightly",
      name: "Nightly",
      description: "desc",
      agent: "github",
      prompt: "summarise",
      llm_provider: "anthropic",
      trigger: { type: "cron", schedule: "0 0 * * *" },
      enabled: false,
    };
    expect(toFormState(task)).toEqual(
      expect.objectContaining({
        id: "nightly",
        triggerType: "cron",
        cronSchedule: "0 0 * * *",
        cronTimezone: "UTC",
        enabled: false,
      }),
    );
  });

  it("maps an interval task to form fields", () => {
    const task: AutonomousTask = {
      id: "every_15",
      name: "N",
      agent: null,
      prompt: "p",
      trigger: { type: "interval", seconds: null, minutes: 15, hours: null },
      enabled: true,
    };
    expect(toFormState(task)).toEqual(
      expect.objectContaining({
        triggerType: "interval",
        intervalSeconds: "",
        intervalMinutes: "15",
        intervalHours: "",
      }),
    );
  });

  it("maps webhook provider, filter, and leaves a stored secret blank", () => {
    const task: AutonomousTask = {
      id: "hook",
      name: "N",
      agent: null,
      prompt: "p",
      trigger: {
        type: "webhook",
        provider: "github",
        has_secret: true,
        filter: {
          conditions: [
            { source: "header", field: "X-GitHub-Event", values: ["pull_request"] },
            { source: "payload", field: "action", values: ["closed"] },
          ],
        },
      },
      enabled: true,
    };
    expect(toFormState(task)).toEqual(
      expect.objectContaining({
        webhookProvider: "github",
        webhookSecret: "",
        webhookFilterEnabled: true,
        webhookFilterConditions: [
          { source: "header", field: "X-GitHub-Event", values: "pull_request" },
          { source: "payload", field: "action", values: "closed" },
        ],
      }),
    );
  });
});

describe("formState.fromFormState", () => {
  const base = {
    ...EMPTY_FORM,
    id: "my_task",
    name: "My task",
    prompt: "do thing",
  };

  it("requires name and prompt", () => {
    expect(fromFormState({ ...base, name: "" })).toEqual({ error: expect.stringMatching(/Name/) });
    expect(fromFormState({ ...base, prompt: "" })).toEqual({ error: expect.stringMatching(/Prompt/) });
  });

  it("passes an empty id straight through on create", () => {
    // The server generates the id and ignores whatever we send; an empty
    // string keeps the wire shape stable without loosening the TS type.
    const result = fromFormState({ ...base, id: "" });
    expect("error" in result).toBe(false);
    expect((result as { task: { id: string } }).task.id).toBe("");
  });

  it("preserves an existing id on edit", () => {
    const result = fromFormState({ ...base, id: "daily-report-a3f9" });
    expect((result as { task: { id: string } }).task.id).toBe("daily-report-a3f9");
  });

  it("parses a valid cron task", () => {
    const result = fromFormState({ ...base, triggerType: "cron", cronSchedule: "0 9 * * *" });
    expect(result).toEqual({
      task: expect.objectContaining({
        id: "my_task",
        trigger: { type: "cron", schedule: "0 9 * * *", timezone: "UTC" },
      }),
    });
  });

  it("rejects empty cron schedule", () => {
    expect(
      fromFormState({ ...base, triggerType: "cron", cronSchedule: "   " }),
    ).toEqual({ error: expect.stringMatching(/Cron schedule/) });
  });

  it("round-trips an IANA timezone for cron schedules", () => {
    const task: AutonomousTask = {
      id: "london-morning",
      name: "London morning",
      agent: null,
      prompt: "report",
      trigger: {
        type: "cron",
        schedule: "0 9 * * *",
        timezone: "Europe/London",
      },
      enabled: true,
    };

    const form = toFormState(task);
    expect(form.cronTimezone).toBe("Europe/London");
    expect(fromFormState(form)).toEqual({
      task: expect.objectContaining({
        trigger: {
          type: "cron",
          schedule: "0 9 * * *",
          timezone: "Europe/London",
        },
      }),
    });
  });

  it("requires at least one interval field", () => {
    expect(fromFormState({ ...base, triggerType: "interval" })).toEqual({
      error: expect.stringMatching(/at least one/),
    });
  });

  it("rejects non-positive / non-integer interval values", () => {
    expect(
      fromFormState({ ...base, triggerType: "interval", intervalMinutes: "-5" }),
    ).toEqual({ error: expect.stringMatching(/positive whole numbers/) });
    expect(
      fromFormState({ ...base, triggerType: "interval", intervalMinutes: "1.5" }),
    ).toEqual({ error: expect.stringMatching(/positive whole numbers/) });
  });

  it("rejects intervals below the default 30-minute minimum", () => {
    expect(
      fromFormState({ ...base, triggerType: "interval", intervalMinutes: "29" }),
    ).toEqual({ error: "Interval must be at least 30 minutes." });
  });

  it("accepts the configured interval minimum", () => {
    const result = fromFormState(
      { ...base, triggerType: "interval", intervalMinutes: "10" },
      600,
    );
    expect(result).toEqual({
      task: expect.objectContaining({
        trigger: { type: "interval", seconds: null, minutes: 10, hours: null },
      }),
    });
  });

  it("maps webhook with blank secret to null for server generation/preservation", () => {
    const result = fromFormState({ ...base, triggerType: "webhook", webhookSecret: "   " });
    expect(result).toEqual({
      task: expect.objectContaining({
        trigger: { type: "webhook", provider: "github", secret: null },
      }),
    });
  });

  it("maps webhook provider and secret verbatim", () => {
    const result = fromFormState({
      ...base,
      triggerType: "webhook",
      webhookProvider: "jira",
      webhookSecret: "s3cret",
    });
    expect(result).toEqual({
      task: expect.objectContaining({
        trigger: { type: "webhook", provider: "jira", secret: "s3cret" },
      }),
    });
  });

  it("maps structured header and payload filters for any provider", () => {
    const result = fromFormState({
      ...base,
      triggerType: "webhook",
      webhookProvider: "jira",
      webhookFilterEnabled: true,
      webhookFilterConditions: [
        { source: "header", field: " X-Event-Type ", values: " issue_updated " },
        { source: "payload", field: "issue.status.name", values: "Done, Closed, Done" },
      ],
    });
    expect(result).toEqual({
      task: expect.objectContaining({
        trigger: {
          type: "webhook",
          provider: "jira",
          secret: null,
          filter: {
            conditions: [
              { source: "header", field: "X-Event-Type", values: ["issue_updated"] },
              { source: "payload", field: "issue.status.name", values: ["Done", "Closed"] },
            ],
          },
        },
      }),
    });
  });

  it("requires a field and accepted value when filtering is enabled", () => {
    expect(fromFormState({
      ...base,
      triggerType: "webhook",
      webhookFilterEnabled: true,
      webhookFilterConditions: [{ source: "payload", field: " ", values: "closed" }],
    })).toEqual({ error: expect.stringMatching(/field name/) });

    expect(fromFormState({
      ...base,
      triggerType: "webhook",
      webhookFilterEnabled: true,
      webhookFilterConditions: [{ source: "payload", field: "action", values: " " }],
    })).toEqual({ error: expect.stringMatching(/at least one accepted value/) });
  });

  it("rejects unsafe payload paths and header names", () => {
    expect(fromFormState({
      ...base,
      triggerType: "webhook",
      webhookFilterEnabled: true,
      webhookFilterConditions: [{ source: "payload", field: "items[0].name", values: "x" }],
    })).toEqual({ error: expect.stringMatching(/dot paths/) });

    expect(fromFormState({
      ...base,
      triggerType: "webhook",
      webhookFilterEnabled: true,
      webhookFilterConditions: [{ source: "header", field: "X Event", values: "x" }],
    })).toEqual({ error: expect.stringMatching(/HTTP header/) });
  });

  it("sends filters for non-GitHub providers", () => {
    const result = fromFormState({
      ...base,
      triggerType: "webhook",
      webhookProvider: "jira",
      webhookFilterEnabled: true,
      webhookFilterConditions: [
        { source: "payload", field: "webhookEvent", values: "jira:issue_updated" },
      ],
    });
    expect(result).toEqual({
      task: expect.objectContaining({
        trigger: {
          type: "webhook",
          provider: "jira",
          secret: null,
          filter: {
            conditions: [
              { source: "payload", field: "webhookEvent", values: ["jira:issue_updated"] },
            ],
          },
        },
      }),
    });
  });

  it("converts empty agent to null", () => {
    const result = fromFormState({ ...base, triggerType: "cron", cronSchedule: "0 9 * * *", agent: "" });
    expect(result).toEqual({ task: expect.objectContaining({ agent: null }) });
  });
});

describe("formState.summarizeTrigger", () => {
  it("summarises cron", () => {
    expect(summarizeTrigger({ type: "cron", schedule: "0 9 * * *" })).toBe(
      "Cron: 0 9 * * * (UTC)",
    );
  });
  it("summarises interval", () => {
    expect(
      summarizeTrigger({ type: "interval", seconds: null, minutes: 15, hours: 2 }),
    ).toBe("Every 2h 15m");
  });
  it("summarises webhook with/without secret", () => {
    expect(summarizeTrigger({ type: "webhook", provider: "jira", has_secret: true })).toBe("Webhook: jira (signed)");
    expect(summarizeTrigger({ type: "webhook", has_secret: false })).toBe("Webhook: github");
  });
});

// Bug fix: dynamic_agent_id was lost on form round-trip, silently
// demoting custom-agent tasks to supervisor tasks on edit. These
// tests pin the round-trip contract so any future regression of
// the converters trips a CI failure rather than a Mongo edit that
// quietly reroutes scheduled work.
describe("formState dynamic_agent_id round-trip", () => {
  it("toFormState surfaces dynamic_agent_id from the wire model", () => {
    const task: AutonomousTask = {
      id: "custom-task",
      name: "Custom Task",
      agent: null,
      dynamic_agent_id: "agent-my-pr-reviewer",
      prompt: "review",
      trigger: { type: "cron", schedule: "0 9 * * *" },
      enabled: true,
    };
    expect(toFormState(task).dynamic_agent_id).toBe("agent-my-pr-reviewer");
  });

  it("toFormState defaults to null when dynamic_agent_id is absent", () => {
    const task: AutonomousTask = {
      id: "supervisor-task",
      name: "Supervisor Task",
      agent: "github",
      prompt: "list prs",
      trigger: { type: "cron", schedule: "0 9 * * *" },
      enabled: true,
    };
    expect(toFormState(task).dynamic_agent_id).toBeNull();
  });

  it("fromFormState preserves dynamic_agent_id on save", () => {
    const form = {
      ...EMPTY_FORM,
      id: "custom-task",
      name: "Custom Task",
      prompt: "review",
      dynamic_agent_id: "agent-my-pr-reviewer",
      triggerType: "cron" as const,
      cronSchedule: "0 9 * * *",
    };
    const result = fromFormState(form);
    expect(result).toEqual({
      task: expect.objectContaining({
        dynamic_agent_id: "agent-my-pr-reviewer",
      }),
    });
  });

  it("full round-trip: load custom-agent task, edit unrelated field, save - dynamic_agent_id survives", () => {
    // Reproduction of the exact bot-flagged regression:
    // user opens an existing custom-agent task in the standalone
    // /autonomous form, changes only the prompt, and saves. The
    // dynamic_agent_id MUST survive untouched so the task continues
    // to route through the dynamic-agents service rather than being
    // silently demoted to the supervisor.
    const original: AutonomousTask = {
      id: "custom-task",
      name: "Custom Task",
      agent: null,
      dynamic_agent_id: "agent-my-pr-reviewer",
      prompt: "old prompt",
      trigger: { type: "cron", schedule: "0 9 * * *" },
      enabled: true,
    };
    const form = toFormState(original);
    form.prompt = "new prompt";
    const result = fromFormState(form);
    expect(result).toEqual({
      task: expect.objectContaining({
        dynamic_agent_id: "agent-my-pr-reviewer",
        prompt: "new prompt",
        agent: null,
      }),
    });
  });
});
